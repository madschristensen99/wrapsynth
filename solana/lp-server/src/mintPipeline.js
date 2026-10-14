// mintPipeline.js — LP mint state machine for the Solana program.
//
// Mirrors lp-server-js processMint/finalizeMint exactly, adapted for Solana:
//   event-driven (EVM)        →  getProgramAccounts scan per tick
//   hub.getMintRequest        →  decoded MintRequest account
//   provideLPKey/setMintReady →  provide_lp_key/set_mint_ready (same semantics)
//   finalizeMint              →  finalize_mint after user SecretRevealed
//   sweepMintDeposit          →  unchanged (pure Monero)
//
// Crash-safety invariants (same as EVM):
//   - lpSecret is persisted BEFORE provide_lp_key is broadcast
//   - every stage re-reads on-chain status before acting (restart-safe)
//   - if lp keys are already on-chain, recover the persisted lpSecret — never
//     generate a second secret for the same request

import { PublicKey, SystemProgram, ComputeBudgetProgram } from '@solana/web3.js';
import {
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
} from '@solana/spl-token';
import { Transaction } from '@solana/web3.js';
import { keccak_256 } from '@noble/hashes/sha3';
import { secrets, accounts } from '../../client/client.js';
import * as moneroCrypto from '../moneroCrypto.js';
import * as moneroWallet from '../moneroWallet.js';
import { cfg } from './config.js';

const ACTIVE = new Set(['pending', 'keyProvided', 'ready', 'secretRevealed']);
const DONE = new Set(['completed', 'cancelled', 'keyCancelled', 'expiredReady']);
const CU = (u) => ComputeBudgetProgram.setComputeUnitLimit({ units: u });

const hex = (arr) => Buffer.from(arr).toString('hex');
/** LE scalar bytes → big-endian hex for sweepMintDeposit's BigInt() path. */
const leToBeHex = (bytes) => '0x' + Buffer.from(bytes).reverse().toString('hex');

export class MintPipeline {
  constructor({ client, vault, store, log = console.log }) {
    this.client = client;
    this.vault = vault;
    this.store = store;
    this.log = log;
    this.inFlight = new Map(); // requestIdHex → Promise
    this.tracked = new Map();  // requestIdHex → metadata for /mints endpoint
  }

  async tick() {
    const reqs = await this.client.fetchRetry(() =>
      this.client.scanMintRequests(this.vault, ACTIVE)
    );
    for (const { pubkey, request } of reqs) this.maybeProcess(pubkey, request);
    // prune finished entries from tracked
    for (const id of this.tracked.keys()) {
      if (!reqs.some((r) => hex(r.request.requestId) === id)) {
        // still tracked but no longer returned by scan — check status once
        const e = this.tracked.get(id);
        if (e.finalStatus && DONE.has(e.finalStatus)) this.tracked.delete(id);
      }
    }
  }

  maybeProcess(pda, req) {
    const id = hex(req.requestId);
    if (this.inFlight.has(id)) return;
    const p = this.process(id, pda, req)
      .catch((e) => this.log(`[mint ${id.slice(0, 8)}] error: ${e.message ?? e}`))
      .finally(() => this.inFlight.delete(id));
    this.inFlight.set(id, p);
  }

  async process(id, pda, req) {
    const status = accounts.statusName(req.status);
    const meta = this.tracked.get(id) || {};
    meta.status = status;
    meta.xmrAmount = req.xmrAmount.toString();
    meta.wsxmrAmount = req.wsxmrAmount.toString();
    meta.recipient = req.recipient.toBase58();
    meta.initiator = req.initiator.toBase58();
    meta.timeout = Number(req.timeout.toString());
    this.tracked.set(id, meta);

    switch (status) {
      case 'pending':
        return this.provideKeys(id, pda, req, meta);
      case 'keyProvided':
        return this.awaitDepositAndReady(id, pda, req, meta);
      case 'ready':
        // waiting for the user to reveal — nothing for the LP to do
        return;
      case 'secretRevealed':
        return this.finalizeAndSweep(id, pda, req, meta);
      default:
        return;
    }
  }

  async refreshReq(pda) {
    return this.client.fetchRetry(() =>
      this.client.program.account.mintRequest.fetch(pda)
    );
  }

  // ── Stage 1: provide_lp_key ────────────────────────────────────────────
  async provideKeys(id, pda, req, meta) {
    const lp = this.client.payer;

    // Binding check: on Solana, claim_commitment = keccak256(user_public_key)
    // (commitment = keccak(compress(secret·G)) and user_public_key IS the
    // compressed point). Refuse to key an unspendable deposit.
    const bound = Buffer.from(keccak_256(Buffer.from(req.userPublicKey)))
      .equals(Buffer.from(req.claimCommitment));
    if (!bound) {
      meta.autoProcessError = 'commitment-pubkey mismatch';
      this.log(`[mint ${id.slice(0, 8)}] REFUSED: claim_commitment != keccak(user_public_key)`);
      return;
    }

    // Recover or generate the LP secret — persisted BEFORE broadcast.
    let entry = this.store.get(id);
    let lpSecret;
    if (entry?.lpSecret) {
      lpSecret = Buffer.from(entry.lpSecret.replace(/^0x/, ''), 'hex');
      this.log(`[mint ${id.slice(0, 8)}] recovered persisted lpSecret`);
    } else {
      const s = secrets.makeSecret();
      lpSecret = s.secret;
      this.store.set(id, {
        lpSecret: '0x' + lpSecret.toString('hex'),
        lpCommitment: '0x' + s.commitment.toString('hex'),
        lpPublicKey: '0x' + s.pubKey.toString('hex'),
        createdAt: Date.now(),
        xmrAmount: req.xmrAmount.toString(),
      });
      entry = this.store.get(id);
      this.log(`[mint ${id.slice(0, 8)}] generated + persisted new lpSecret`);
    }

    const lpPub = secrets.computePublicKey(lpSecret);
    const lpCommitment = secrets.computeCommitment(lpSecret);

    // If keys are already on-chain (restart between broadcast and confirm),
    // verify they match our persisted secret before proceeding.
    const chainSpend = Buffer.from(req.lpPublicSpendKey);
    if (!chainSpend.equals(Buffer.alloc(32)) && !chainSpend.equals(lpPub)) {
      meta.autoProcessError = 'on-chain lp spend key != persisted secret';
      this.log(`[mint ${id.slice(0, 8)}] FATAL: on-chain LP keys don't match persisted secret — manual intervention`);
      return;
    }

    if (chainSpend.equals(Buffer.alloc(32))) {
      await this.client.rpcIx(
        this.client.program.methods
          .provideLpKey(Array.from(lpPub), Array.from(lpPub), Array.from(lpCommitment))
          .accounts({
            lp: lp.publicKey,
            vault: this.vault,
            globalState: this.client.globalState,
            mintRequest: pda,
            ...this.client.oracleAccounts(),
          }),
        []
      );
      this.log(`[mint ${id.slice(0, 8)}] provide_lp_key confirmed`);
    } else {
      this.log(`[mint ${id.slice(0, 8)}] keys already on-chain, skipping provide_lp_key`);
    }

    // Deposit address: user spends + LP spends combined; viewable via lpSecret
    // (new scheme — lpPublicViewKey = lpPublicSpendKey).
    meta.depositAddress = await moneroCrypto.computeDepositAddress(
      hex(req.userPublicKey), hex(lpPub), hex(lpPub)
    );
    this.store.set(id, { depositAddress: meta.depositAddress });
    this.log(`[mint ${id.slice(0, 8)}] deposit address: ${meta.depositAddress}`);

    return this.awaitDepositAndReady(id, pda, await this.refreshReq(pda), meta);
  }

  // ── Stage 2: deposit scan → set_mint_ready ─────────────────────────────
  async awaitDepositAndReady(id, pda, req, meta) {
    const entry = this.store.get(id);
    if (!entry?.lpSecret) {
      this.log(`[mint ${id.slice(0, 8)}] no persisted lpSecret — cannot verify deposit`);
      return;
    }
    let depositAddress = meta.depositAddress || entry.depositAddress;
    if (!depositAddress) {
      const lpPub = secrets.computePublicKey(
        Buffer.from(entry.lpSecret.replace(/^0x/, ''), 'hex')
      );
      depositAddress = await moneroCrypto.computeDepositAddress(
        hex(req.userPublicKey), hex(lpPub), hex(lpPub)
      );
      meta.depositAddress = depositAddress;
    }

    if (!moneroWallet.isWalletConfigured?.() && !process.env.MONERO_WALLET_RPC_URL) {
      if (process.env.SKIP_DEPOSIT_VERIFICATION === '1') {
        this.log(`[mint ${id.slice(0, 8)}] SKIP_DEPOSIT_VERIFICATION=1 — marking ready without XMR scan`);
      } else {
        this.log(`[mint ${id.slice(0, 8)}] no Monero wallet configured — cannot verify deposit, waiting`);
        return;
      }
    } else {
      const expected = BigInt(req.xmrAmount.toString());
      this.log(`[mint ${id.slice(0, 8)}] scanning for ${expected} XMR atomic → ${depositAddress}`);
      try {
        const height = await moneroWallet.getDaemonHeight().catch(() => 0);
        const restoreHeight = Math.max(0, height - 1000);
        const depositTx = await moneroWallet.pollForDeposit(expected, {
          depositAddress,
          viewKeyHex: entry.lpSecret.replace(/^0x/, ''),
          restoreHeight,
          toleranceBps: cfg.depositToleranceBps,
          intervalMs: cfg.depositPollIntervalMs,
          maxWaitMs: cfg.depositMaxWaitMs,
          shouldAbort: async () => {
            const r = await this.refreshReq(pda).catch(() => null);
            if (!r) return false;
            const s = accounts.statusName(r.status);
            return DONE.has(s);
          },
        });
        meta.depositTx = depositTx;
        this.store.set(id, { depositTxHash: depositTx.txid, depositHeight: depositTx.height });
        this.log(`[mint ${id.slice(0, 8)}] deposit verified: ${depositTx.txid}`);
      } catch (e) {
        const r = await this.refreshReq(pda).catch(() => null);
        if (r && DONE.has(accounts.statusName(r.status))) {
          this.log(`[mint ${id.slice(0, 8)}] request resolved while scanning — stopping`);
          return;
        }
        meta.autoProcessError = e.message;
        this.log(`[mint ${id.slice(0, 8)}] deposit scan failed: ${e.message} — will retry next tick`);
        return;
      }
    }

    // Deposit verified → set_mint_ready
    const cur = await this.refreshReq(pda);
    if (accounts.statusName(cur.status) !== 'keyProvided') {
      this.log(`[mint ${id.slice(0, 8)}] status moved to ${accounts.statusName(cur.status)} before set_mint_ready — skipping`);
      return;
    }
    await this.client.rpcIx(
      this.client.program.methods.setMintReady().accounts({
        lp: this.client.payer.publicKey,
        vault: this.vault,
        globalState: this.client.globalState,
        mintRequest: pda,
        ...this.client.oracleAccounts(),
      }),
      []
    );
    this.log(`[mint ${id.slice(0, 8)}] set_mint_ready confirmed — waiting for user reveal`);
  }

  // ── Stage 3: finalize_mint + sweep the Monero deposit ──────────────────
  async finalizeAndSweep(id, pda, req, meta) {
    const entry = this.store.get(id);
    const lp = this.client.payer;

    const recipientWsxmrAta = getAssociatedTokenAddressSync(
      this.client.wsxmrMint, req.recipient, true, TOKEN_2022_PROGRAM_ID
    );
    const lpWsxmrAta = getAssociatedTokenAddressSync(
      this.client.wsxmrMint, lp.publicKey, true, TOKEN_2022_PROGRAM_ID
    );
    // LP's wsXMR ATA must exist for the fee mint — create if needed.
    if (!(await this.client.conn.getAccountInfo(lpWsxmrAta))) {
      const tx = new Transaction().add(
        createAssociatedTokenAccountInstruction(
          lp.publicKey, lpWsxmrAta, lp.publicKey,
          this.client.wsxmrMint, TOKEN_2022_PROGRAM_ID
        )
      );
      await this.client.conn.sendTransaction(tx, [lp]).then((s) => this.client.confirm(s));
      this.log(`[mint ${id.slice(0, 8)}] created LP wsXMR ATA`);
    }

    const cur = await this.refreshReq(pda);
    if (accounts.statusName(cur.status) === 'secretRevealed') {
      await this.client.rpcIx(
        this.client.program.methods.finalizeMint()
          .preInstructions([CU(400_000)])
          .accounts({
            caller: lp.publicKey,
            vaultLp: lp.publicKey,
            vault: this.vault,
            globalState: this.client.globalState,
            mintRequest: pda,
            wsxmrMint: this.client.wsxmrMint,
            recipientWsxmrAta,
            lpWsxmrAta,
            pendingReturns: this.client.pendingReturns(req.initiator),
            ...this.client.collateralAccounts(this.vault),
            tokenProgram: TOKEN_2022_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          }),
        []
      );
      this.log(`[mint ${id.slice(0, 8)}] finalize_mint confirmed`);
    }

    // Sweep the locked Monero deposit: user_secret + lp_secret → combined spend.
    if (!entry?.lpSecret || !cfg.lpMoneroAddress) {
      this.log(`[mint ${id.slice(0, 8)}] finalized — sweep skipped (${!entry?.lpSecret ? 'no lpSecret' : 'LP_MONERO_ADDRESS unset'})`);
      meta.finalStatus = 'completed';
      return;
    }
    const revealed = Buffer.from(req.revealedSecret);
    if (revealed.equals(Buffer.alloc(32))) {
      // re-fetch — revealed_secret may have landed after our last read
      const r2 = await this.refreshReq(pda);
      revealed.copy(Buffer.from(r2.revealedSecret));
    }
    try {
      const res = await moneroWallet.sweepMintDeposit({
        userSecretHex: leToBeHex(revealed),
        lpSecretHex: entry.lpSecret.replace(/^0x/, ''),
        lpMainAddress: cfg.lpMoneroAddress,
        restoreHeight: Math.max(0, (entry.depositHeight || 0) - 5),
        depositHeight: entry.depositHeight || 0,
        viewKeyLeHex: entry.lpSecret.replace(/^0x/, ''),
      });
      this.log(`[mint ${id.slice(0, 8)}] sweep: ${res.swept ? `swept ${res.amount}` : 'nothing found'} txs=${res.txHashes.length}`);
      this.store.set(id, { swept: res.swept, sweepTxs: res.txHashes });
    } catch (e) {
      this.log(`[mint ${id.slice(0, 8)}] sweep failed: ${e.message} — secret persisted, can retry`);
      meta.autoProcessError = 'sweep: ' + e.message;
      return;
    }
    meta.finalStatus = 'completed';
  }
}
