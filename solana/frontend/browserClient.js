// browserClient.js — browser-side WrapSynth client.
// Same conventions as solana/client, minus the Node-only bits (fs/config/keypair):
// config + IDL are bundled, signing is delegated to the injected wallet.

import { Connection, PublicKey } from '@solana/web3.js';
import * as anchor from '@coral-xyz/anchor';
import * as conn_ from '../client/connection.js';
import * as pdas from '../client/pdas.js';
import * as accounts from '../client/accounts.js';
import * as secrets from '../client/secrets.js';
import idl from './idl.json';
import cfgJson from './devnet-config.json';

export { pdas, accounts, secrets, conn_ };
export const cfg = {
  raw: cfgJson,
  rpc: cfgJson.rpc,
  programId: new PublicKey(cfgJson.programId),
  globalState: new PublicKey(cfgJson.globalState),
  wsxmrMint: new PublicKey(cfgJson.wsxmrMint),
  collateralMint: new PublicKey(cfgJson.collateralMint),
  programCollateralAta: new PublicKey(cfgJson.programCollateralAta),
  solEscrow: new PublicKey(cfgJson.solEscrow),
  oracleXmr: new PublicKey(cfgJson.oracle.xmr),
  oracleQqqx: new PublicKey(cfgJson.oracle.qqqx),
};

export const conn = new Connection(cfg.rpc, 'confirmed');
export const confirm = (sig, t) => conn_.confirm(conn, sig, t);
export const fetchRetry = conn_.fetchRetry;
export const program = new anchor.Program(idl, makeProvider());
export const programId = program.programId;

function makeProvider(wallet) {
  const w = wallet || { publicKey: PublicKey.default, signTransaction: async (t) => t, signAllTransactions: async (t) => t };
  return new anchor.AnchorProvider(conn, w, { commitment: 'confirmed' });
}

/** Attach the Phantom (or any injected) wallet — rebuilds the program binding. */
export function attachWallet(wallet) {
  const provider = makeProvider(wallet);
  const p = new anchor.Program(idl, provider);
  Object.assign(program, p);
  return program;
}

/**
 * Build → wallet-sign → HTTP send → HTTP-poll confirm.
 * All wallet-side txs are single-signer (the connected wallet).
 */
export async function walletTx(builder, wallet, { paceMs = 1500 } = {}) {
  const tx = await builder.transaction();
  tx.feePayer = wallet.publicKey;
  tx.recentBlockhash = (await conn.getLatestBlockhash('confirmed')).blockhash;
  const signed = await wallet.signTransaction(tx);
  const sig = await conn.sendRawTransaction(signed.serialize());
  await confirm(sig);
  if (paceMs) await new Promise((r) => setTimeout(r, paceMs));
  return sig;
}

// ── PDA + account helpers (bound to this deployment) ───────────────────────
export const vaultPda = (lp) => pdas.vaultPda(lp, programId);
export const pendingReturns = (o) => pdas.pendingReturnsPda(o, programId);
export const vaultCollateralAta = (v) => pdas.vaultCollateralAtaPda(v, programId);
export const oracleAccounts = () => ({ pythXmr: cfg.oracleXmr, pythCollateral: cfg.oracleQqqx });
export const collateralAccounts = (v) => ({
  collateralMint: cfg.collateralMint,
  vaultCollateralAta: vaultCollateralAta(v),
  programCollateralAta: cfg.programCollateralAta,
});
export const nextNonce = () => pdas.nextRequestNonce(program, cfg.globalState);
export const listVaults = () => fetchRetry(() => program.account.vault.all());
export const scanMintsForUser = async (userPk) =>
  fetchRetry(() => program.account.mintRequest.all()).then((all) =>
    all.filter((r) => r.account.initiator.equals(userPk)));
export const scanBurnsForUser = async (userPk) =>
  fetchRetry(() => program.account.burnRequest.all()).then((all) =>
    all.filter((r) => r.account.user.equals(userPk)));
