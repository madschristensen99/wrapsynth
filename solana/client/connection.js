// connection.js — RPC connection + transaction plumbing.
//
// DEVNET RULES (learned the hard way):
//   - Public devnet RPC rate-limits hard. anchor's .rpc() confirms via
//     websocket signature subscriptions, which die unrecoverably under 429s.
//     ALWAYS send via sendAndConfirm() here: .transaction() + HTTP send +
//     getSignatureStatuses polling (HTTP 429s auto-retry inside web3).
//   - conn.sendTransaction does NOT confirm — always await confirm() after.
//   - Read and write at the SAME commitment. The localnet suite lost a day to
//     writes confirming at "processed" while ATA reads ran at "confirmed"
//     (the confirmed bank lags on fast localnets).
//   - Pace bursts: rpcIx() sleeps ~2s after each confirmed tx to stay inside
//     the public RPC's per-IP budget. Point DEVNET_URL at a real RPC
//     (Helius/QuickNode) for anything serious.

import { Connection } from '@solana/web3.js';
import * as anchor from '@coral-xyz/anchor';

export const DEFAULT_COMMITMENT = 'confirmed';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Create a Connection. Some providers (Alchemy free tier) block
 * getProgramAccounts — when the primary URL isn't api.devnet.solana.com, GPA
 * calls are re-routed to `gpaUrl` (default: public devnet) with retries.
 * Everything else hits the primary endpoint.
 */
export function makeConnection(url, gpaUrl = process.env.GPA_URL || 'https://api.devnet.solana.com') {
  const conn = new Connection(url, DEFAULT_COMMITMENT);
  if (!url.includes('api.devnet.solana.com') && gpaUrl && gpaUrl !== url) {
    const gpaConn = new Connection(gpaUrl, DEFAULT_COMMITMENT);
    const gpa = gpaConn.getProgramAccounts.bind(gpaConn);
    conn.getProgramAccounts = async (...args) => {
      let last;
      for (let i = 0; i < 12; i++) {
        try {
          return await gpa(...args);
        } catch (e) {
          last = e;
          await sleep(4000);
        }
      }
      throw last;
    };
  }
  return conn;
}

/** HTTP-poll confirmation — no websocket path. Throws on tx error. */
export async function confirm(conn, sig, timeoutMs = 60_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const st = await conn.getSignatureStatuses([sig]);
    const v = st?.value?.[0];
    if (v?.err) throw new Error('tx failed: ' + JSON.stringify(v.err));
    if (
      v?.confirmationStatus === 'confirmed' ||
      v?.confirmationStatus === 'finalized'
    )
      return v;
    await sleep(2500);
  }
  throw new Error('confirmation timeout: ' + sig);
}

/** Send + confirm via HTTP polling (429-safe). */
export async function sendAndConfirm(conn, tx, signers, opts = {}) {
  const sig = await conn.sendTransaction(tx, signers, opts);
  await confirm(conn, sig, opts.timeoutMs);
  return sig;
}

/**
 * Anchor builder → built tx → HTTP send/confirm. Payer must be included in
 * signers (it is the fee payer set by builder.transaction()).
 */
export async function rpcIx(conn, builder, signers, { paceMs = 2000 } = {}) {
  const tx = await builder.transaction();
  const sig = await sendAndConfirm(conn, tx, signers);
  if (paceMs) await sleep(paceMs);
  return sig;
}

/** Retry wrapper for read calls that can hit 429s. */
export async function fetchRetry(fn, tries = 8, delayMs = 3000) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (i < tries - 1) await sleep(delayMs);
    }
  }
  throw last;
}

/** Minimal anchor.Wallet over a raw Keypair (LP server side — no adapter). */
export class KeypairWallet {
  constructor(keypair) {
    this.payer = keypair;
    this.publicKey = keypair.publicKey;
  }
  async signTransaction(tx) {
    tx.partialSign(this.payer);
    return tx;
  }
  async signAllTransactions(txs) {
    return txs.map((tx) => {
      tx.partialSign(this.payer);
      return tx;
    });
  }
}

export function makeProvider(conn, keypair) {
  return new anchor.AnchorProvider(conn, new KeypairWallet(keypair), {
    commitment: DEFAULT_COMMITMENT,
  });
}

export function loadProgram(conn, keypair, idl) {
  return new anchor.Program(idl, makeProvider(conn, keypair));
}
