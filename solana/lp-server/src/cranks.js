// cranks.js — periodic housekeeping: time-outs, sweeps, reconciliation.
//
// These instructions are all on-chain but nobody calls them unless a process
// like this does. Each is gated by on-chain conditions (deadline checks), so
// calling early is harmless — the program rejects and we try again next tick.
//
//   mint pending/keyProvided/ready/secretRevealed past timeout → cancel_mint
//     (cancel_mint does an inline finalize for secretRevealed — user payout
//     still lands even when the LP path stalled)
//   keyCancelled mint + persisted lpSecret → abandon_key_provided_mint
//     (claims the parked griefing deposit for the LP and publishes lp_secret
//     on-chain so the user can recover their XMR)
//   expiredReady past second timeout → sweep_unclaimed_expired_mint
//   committed burn past deadline → force_settle_burn (permissionless)
//   every N ticks → reconcile_global_debt (authority only — skipped if our
//     signer isn't the protocol authority)

import { SystemProgram, ComputeBudgetProgram, Transaction } from '@solana/web3.js';
import {
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
} from '@solana/spl-token';
import { accounts } from '../../client/client.js';
import { cfg } from './config.js';

const CU = (u) => ComputeBudgetProgram.setComputeUnitLimit({ units: u });
const hex = (arr) => Buffer.from(arr).toString('hex');
const RECONCILE_EVERY_TICKS = 40; // ~10 min at 15s poll

export class Cranks {
  constructor({ client, vault, mintStore, log = console.log }) {
    this.client = client;
    this.vault = vault;
    this.mintStore = mintStore;
    this.log = log;
    this.tickCount = 0;
  }

  wsxmrAta = (owner) =>
    getAssociatedTokenAddressSync(this.client.wsxmrMint, owner, true, TOKEN_2022_PROGRAM_ID);

  async ensureAta(owner) {
    const ata = this.wsxmrAta(owner);
    if (!(await this.client.conn.getAccountInfo(ata))) {
      const tx = new Transaction().add(createAssociatedTokenAccountInstruction(
        this.client.payer.publicKey, ata, owner,
        this.client.wsxmrMint, TOKEN_2022_PROGRAM_ID));
      await this.client.conn.sendTransaction(tx, [this.client.payer])
        .then((s) => this.client.confirm(s));
      this.log(`[crank] created wsXMR ATA for ${owner.toBase58().slice(0, 8)}`);
    }
    return ata;
  }

  async tick() {
    this.tickCount++;
    const now = Math.floor(Date.now() / 1000);

    // ── Mint timeouts ──────────────────────────────────────────────────────
    const mints = await this.client.fetchRetry(() =>
      this.client.scanMintRequests(this.vault,
        new Set(['pending', 'keyProvided', 'ready', 'secretRevealed', 'keyCancelled', 'expiredReady']))
    );
    for (const { pubkey, request: req } of mints) {
      const id = hex(req.requestId).slice(0, 8);
      const status = accounts.statusName(req.status);
      const timeout = Number(req.timeout.toString());
      try {
        if (['pending', 'keyProvided', 'ready', 'secretRevealed'].includes(status) && now >= timeout) {
          await this.cancelMint(id, pubkey, req);
        } else if (status === 'keyCancelled') {
          await this.abandonKeyed(id, pubkey);
        } else if (status === 'expiredReady' && now >= timeout) {
          await this.client.rpcIx(
            this.client.program.methods.sweepUnclaimedExpiredMint().accounts({
              caller: this.client.payer.publicKey,
              vault: this.vault,
              globalState: this.client.globalState,
              mintRequest: pubkey,
              initiatorReturns: this.client.pendingReturns(req.initiator),
              ...this.client.collateralAccounts(this.vault),
              tokenProgram: TOKEN_2022_PROGRAM_ID,
              systemProgram: SystemProgram.programId,
            }),
            []
          );
          this.log(`[crank] swept expired mint ${id}`);
        }
      } catch (e) {
        this.log(`[crank] mint ${id} (${status}) crank failed: ${e.message}`);
      }
    }

    // ── Burn deadline: committed past deadline → force settle ──────────────
    const burns = await this.client.fetchRetry(() =>
      this.client.scanBurnRequests(this.vault, new Set(['committed']))
    );
    for (const { pubkey, request: req } of burns) {
      const id = hex(req.requestId).slice(0, 8);
      if (Number(req.deadline.toString()) > now) continue;
      try {
        await this.client.rpcIx(
          this.client.program.methods.forceSettleBurn().accounts({
            caller: this.client.payer.publicKey,
            vault: this.vault,
            globalState: this.client.globalState,
            burnRequest: pubkey,
            userPendingReturns: this.client.pendingReturns(req.user),
            ...this.client.oracleAccounts(),
            ...this.client.collateralAccounts(this.vault),
            tokenProgram: TOKEN_2022_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          }),
          []
        );
        this.log(`[crank] force-settled committed burn ${id}`);
      } catch (e) {
        this.log(`[crank] force_settle ${id} failed: ${e.message}`);
      }
    }

    // ── Global debt reconciliation (authority only) ────────────────────────
    if (this.tickCount % RECONCILE_EVERY_TICKS === 0) {
      try {
        const gs = await this.client.fetchRetry(() =>
          this.client.program.account.globalState.fetch(this.client.globalState));
        if (gs.authority.equals(this.client.payer.publicKey)) {
          await this.client.rpcIx(
            this.client.program.methods.reconcileGlobalDebt().accounts({
              authority: this.client.payer.publicKey,
              globalState: this.client.globalState,
            }),
            []
          );
          this.log('[crank] reconcile_global_debt ok');
        }
      } catch (e) {
        this.log(`[crank] reconcile failed: ${e.message}`);
      }
    }
  }

  async cancelMint(id, pda, req) {
    const initiatorReturns = this.client.pendingReturns(req.initiator);
    const lpReturns = this.client.pendingReturns(this.client.payer.publicKey);
    for (const pr of [initiatorReturns, lpReturns]) {
      if (!(await this.client.conn.getAccountInfo(pr))) {
        // PendingReturns must exist — user init is required before initiate, so
        // a missing account means this request is malformed; skip.
        this.log(`[crank] mint ${id}: pending-returns missing, skipping cancel`);
        return;
      }
    }
    // Both wsXMR ATAs are required accounts regardless of status branch.
    const recipientAta = await this.ensureAta(req.recipient);
    const lpAta = await this.ensureAta(this.client.payer.publicKey);
    await this.client.rpcIx(
      this.client.program.methods.cancelMint().preInstructions([CU(400_000)]).accounts({
        caller: this.client.payer.publicKey,
        vault: this.vault,
        globalState: this.client.globalState,
        mintRequest: pda,
        initiatorReturns,
        lpReturns,
        wsxmrMint: this.client.wsxmrMint,
        recipientWsxmrAta: recipientAta,
        lpWsxmrAta: lpAta,
        ...this.client.collateralAccounts(this.vault),
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      }),
      []
    );
    this.log(`[crank] cancel_mint ${id} confirmed`);
    // KeyProvided → KeyCancelled: LP now has a claim window on the parked deposit.
    if (accounts.statusName(req.status) === 'keyProvided') {
      await this.abandonKeyed(id, pda);
    }
  }

  async abandonKeyed(id, pda) {
    const full = Object.keys(this.mintStore.data).find((k) => k.startsWith(id));
    const entry = full && this.mintStore.get(full);
    if (!entry?.lpSecret) {
      this.log(`[crank] mint ${id} keyCancelled but no lpSecret persisted — cannot abandon`);
      return;
    }
    const lpSecret = Buffer.from(entry.lpSecret.replace(/^0x/, ''), 'hex');
    await this.client.rpcIx(
      this.client.program.methods.abandonKeyProvidedMint(Array.from(lpSecret)).accounts({
        lp: this.client.payer.publicKey,
        vault: this.vault,
        globalState: this.client.globalState,
        mintRequest: pda,
        lpReturns: this.client.pendingReturns(this.client.payer.publicKey),
        systemProgram: SystemProgram.programId,
      }),
      []
    );
    this.log(`[crank] abandoned keyed mint ${id} — parked deposit claimed, lpSecret published`);
  }
}
