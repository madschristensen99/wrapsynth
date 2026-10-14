// burnPipeline.js — LP burn state machine for the Solana program.
//
// Mirrors lp-server-js/burnHandler.js, adapted for account scanning:
//   requested → propose_hash(commitment, lp_spend, lp_view) → send XMR to the
//               shared burn address (user_spend + lp_spend, viewable by user)
//   committed → finalize_burn(lp_secret) — reveals LP secret on-chain so the
//               user can sweep the shared XMR (their payout)
//   slashed / resolved-with-user-secret → LP sweeps the shared XMR BACK to its
//               main wallet (it now knows both secrets)
//
// Crash-safety: the burn secret is persisted BEFORE propose_hash. If the LP
// crashes after sending XMR, the persisted secret is the only path to recover.

import { SystemProgram, ComputeBudgetProgram } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { secrets, accounts } from '../../client/client.js';
import * as moneroCrypto from '../moneroCrypto.js';
import * as moneroWallet from '../moneroWallet.js';
import { cfg } from './config.js';

const ACTIVE = new Set(['requested', 'proposed', 'committed']);
const TERMINAL = new Set(['completed', 'slashed', 'cancelled']);
const CU = (u) => ComputeBudgetProgram.setComputeUnitLimit({ units: u });

const hex = (arr) => Buffer.from(arr).toString('hex');
/** LE scalar bytes → big-endian hex for sweepMintDeposit's BigInt() path. */
const leToBeHex = (bytes) => '0x' + Buffer.from(bytes).reverse().toString('hex');
const ZERO32 = Buffer.alloc(32);

export class BurnPipeline {
  constructor({ client, vault, store, log = console.log }) {
    this.client = client;
    this.vault = vault;
    this.store = store;
    this.log = log;
    this.inFlight = new Map();
    this.tracked = new Map();
  }

  async tick() {
    const reqs = await this.client.fetchRetry(() =>
      this.client.scanBurnRequests(this.vault,
        new Set([...ACTIVE, 'slashed', 'cancelled']))
    );
    for (const { pubkey, request } of reqs) this.maybeProcess(pubkey, request);
    for (const id of this.tracked.keys()) {
      const e = this.tracked.get(id);
      if (e.finalStatus && TERMINAL.has(e.finalStatus)) this.tracked.delete(id);
    }
  }

  maybeProcess(pda, req) {
    const id = hex(req.requestId);
    if (this.inFlight.has(id)) return;
    const p = this.process(id, pda, req)
      .catch((e) => this.log(`[burn ${id.slice(0, 8)}] error: ${e.message ?? e}`))
      .finally(() => this.inFlight.delete(id));
    this.inFlight.set(id, p);
  }

  async process(id, pda, req) {
    const status = accounts.statusName(req.status);
    const meta = this.tracked.get(id) || {};
    meta.status = status;
    meta.wsxmrAmount = req.wsxmrAmount.toString();
    meta.xmrAmount = req.xmrAmount.toString();
    meta.user = req.user.toBase58();
    meta.deadline = Number(req.deadline.toString());
    this.tracked.set(id, meta);

    switch (status) {
      case 'requested':
        return this.propose(id, pda, req, meta);
      case 'proposed':
        return this.checkProposedDeadline(id, pda, req, meta);
      case 'committed':
        return this.finalize(id, pda, req, meta);
      case 'slashed':
      case 'cancelled':
        return this.sweepBack(id, req, meta);
      default:
        return;
    }
  }

  async refreshReq(pda) {
    return this.client.fetchRetry(() =>
      this.client.program.account.burnRequest.fetch(pda)
    );
  }

  // ── Stage 1: propose_hash → send XMR to shared address ──────────────────
  async propose(id, pda, req, meta) {
    const lp = this.client.payer;

    let entry = this.store.get(id);
    let secret;
    if (entry?.lpSecret) {
      secret = Buffer.from(entry.lpSecret.replace(/^0x/, ''), 'hex');
      this.log(`[burn ${id.slice(0, 8)}] recovered persisted lpSecret`);
    } else {
      const s = secrets.makeSecret();
      secret = s.secret;
      this.store.set(id, {
        lpSecret: '0x' + secret.toString('hex'),
        lpCommitment: '0x' + s.commitment.toString('hex'),
        lpPublicKey: '0x' + s.pubKey.toString('hex'),
        createdAt: Date.now(),
        xmrAmount: req.xmrAmount.toString(),
      });
      entry = this.store.get(id);
      this.log(`[burn ${id.slice(0, 8)}] generated + persisted burn secret`);
    }

    const lpPub = secrets.computePublicKey(secret);
    const commitment = secrets.computeCommitment(secret);

    const chainSpend = Buffer.from(req.lpPublicSpendKey);
    if (!chainSpend.equals(ZERO32) && !chainSpend.equals(lpPub)) {
      meta.autoProcessError = 'on-chain lp spend key != persisted secret';
      this.log(`[burn ${id.slice(0, 8)}] FATAL: on-chain LP keys don't match persisted secret`);
      return;
    }

    // propose_hash on-chain FIRST — if the tx reverts, no XMR is sent to an
    // unproposed shared address.
    if (chainSpend.equals(ZERO32)) {
      await this.client.rpcIx(
        this.client.program.methods.proposeHash(
          Array.from(commitment), Array.from(lpPub), Array.from(lpPub)
        ).accounts({ lp: lp.publicKey, vault: this.vault, burnRequest: pda }),
        []
      );
      this.log(`[burn ${id.slice(0, 8)}] propose_hash confirmed`);
    } else {
      this.log(`[burn ${id.slice(0, 8)}] proposal already on-chain, skipping`);
    }

    // Shared burn address: user_spend + lp_spend, view key = user's.
    meta.sharedAddress = await moneroCrypto.computeBurnAddress(
      hex(req.userPublicKey), hex(req.userViewKey), hex(lpPub)
    );
    this.store.set(id, { sharedAddress: meta.sharedAddress });
    this.log(`[burn ${id.slice(0, 8)}] shared address: ${meta.sharedAddress}`);

    // Send the payout XMR — after the proposal is on-chain.
    if (!moneroWallet.isWalletConfigured()) {
      if (process.env.SKIP_BURN_XMR_SEND === '1') {
        this.log(`[burn ${id.slice(0, 8)}] SKIP_BURN_XMR_SEND=1 — no XMR sent (devnet)`);
      } else {
        this.log(`[burn ${id.slice(0, 8)}] no Monero wallet — cannot send payout; user will not confirm`);
      }
      return;
    }
    if (!entry.moneroTxHash) {
      try {
        const res = await moneroWallet.sendXmr({
          destination: meta.sharedAddress,
          amountAtomic: BigInt(req.xmrAmount.toString()),
        });
        this.store.set(id, { moneroTxHash: res.txHash });
        meta.moneroTxHash = res.txHash;
        this.log(`[burn ${id.slice(0, 8)}] XMR sent: ${res.txHash}`);
      } catch (e) {
        meta.autoProcessError = 'xmr-send: ' + e.message;
        this.log(`[burn ${id.slice(0, 8)}] XMR send failed: ${e.message} — will retry next tick`);
      }
    } else {
      this.log(`[burn ${id.slice(0, 8)}] XMR already sent (${entry.moneroTxHash})`);
    }
  }

  // ── Stage 1b: proposed waiting for user confirm — deadline check ─────────
  async checkProposedDeadline(id, pda, req, meta) {
    const now = Math.floor(Date.now() / 1000);
    if (meta.deadline > now) return; // still in user's confirm window
    // Deadline passed — LP can reclaim by abandoning the proposal.
    try {
      await this.client.rpcIx(
        this.client.program.methods.abandonProposedBurn().accounts({
          lp: this.client.payer.publicKey, vault: this.vault, burnRequest: pda,
        }),
        []
      );
      this.log(`[burn ${id.slice(0, 8)}] abandon_proposed_burn confirmed (expired proposal)`);
    } catch (e) {
      this.log(`[burn ${id.slice(0, 8)}] abandon_proposed_burn failed: ${e.message}`);
    }
  }

  // ── Stage 2: committed → finalize_burn ──────────────────────────────────
  async finalize(id, pda, req, meta) {
    const entry = this.store.get(id);
    if (!entry?.lpSecret) {
      this.log(`[burn ${id.slice(0, 8)}] committed but no persisted lpSecret — cannot finalize`);
      return;
    }
    const cur = await this.refreshReq(pda);
    if (accounts.statusName(cur.status) !== 'committed') {
      this.log(`[burn ${id.slice(0, 8)}] status moved to ${accounts.statusName(cur.status)} before finalize — skipping`);
      return;
    }
    const secret = Buffer.from(entry.lpSecret.replace(/^0x/, ''), 'hex');
    await this.client.rpcIx(
      this.client.program.methods.finalizeBurn(Array.from(secret))
        .preInstructions([CU(400_000)])
        .accounts({
          caller: this.client.payer.publicKey,
          vaultLp: this.client.payer.publicKey,
          vault: this.vault,
          globalState: this.client.globalState,
          burnRequest: pda,
          userPendingReturns: this.client.pendingReturns(req.user),
          ...this.client.oracleAccounts(),
          ...this.client.collateralAccounts(this.vault),
          tokenProgram: TOKEN_2022_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        }),
      []
    );
    this.log(`[burn ${id.slice(0, 8)}] finalize_burn confirmed — user can sweep shared XMR`);
    meta.status = 'completed';
    meta.finalStatus = 'completed';
  }

  // ── Terminal: user revealed their secret (decline/slash) → LP sweeps back ─
  async sweepBack(id, req, meta) {
    const entry = this.store.get(id);
    const userSecret = Buffer.from(req.revealedSecret);
    if (userSecret.equals(ZERO32)) {
      // Liquidation-path slash — no user secret on-chain; nothing to sweep.
      meta.finalStatus = accounts.statusName(req.status);
      return;
    }
    if (!entry?.lpSecret) {
      this.log(`[burn ${id.slice(0, 8)}] user secret revealed but no lpSecret — cannot sweep back`);
      return;
    }
    if (entry.sweptBack) return;
    if (!moneroWallet.isWalletConfigured() || !cfg.lpMoneroAddress) {
      if (entry.sweepSkippedLogged) return;
      this.log(`[burn ${id.slice(0, 8)}] sweep-back skipped (no wallet / LP_MONERO_ADDRESS unset)`);
      this.store.set(id, { sweepSkippedLogged: true });
      return;
    }
    try {
      const res = await moneroWallet.sweepBurnShared({
        userSecretHex: leToBeHex(userSecret),
        lpSecretHex: entry.lpSecret.replace(/^0x/, ''),
        lpMainAddress: cfg.lpMoneroAddress,
        restoreHeight: 0,
      });
      this.store.set(id, { sweptBack: res.swept, sweepTxs: res.txHashes });
      this.log(`[burn ${id.slice(0, 8)}] sweep-back: ${res.swept ? `recovered ${res.amount}` : 'nothing found'}`);
    } catch (e) {
      this.log(`[burn ${id.slice(0, 8)}] sweep-back failed: ${e.message} — retry next tick`);
    }
    meta.finalStatus = accounts.statusName(req.status);
  }
}
