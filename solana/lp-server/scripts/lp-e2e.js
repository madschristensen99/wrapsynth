// lp-e2e.js — end-to-end driver against the RUNNING lp-server.
//
// Sets up our LP wallet's vault (idempotent), then initiates a mint as a fresh
// user and watches the LP server drive it: provide_lp_key → set_mint_ready →
// (user reveals) → finalize_mint. Run with the lp-server already up:
//
//   LP_KEYPAIR=~/.config/solana/id.json PORT=3002 SKIP_DEPOSIT_VERIFICATION=1 \
//     node server.js            # terminal 1
//   node scripts/lp-e2e.js      # terminal 2

import { Keypair, PublicKey, SystemProgram, Transaction, ComputeBudgetProgram } from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync, createAssociatedTokenAccountInstruction, getAccount, ASSOCIATED_TOKEN_PROGRAM_ID } from '@solana/spl-token';
import BN from 'bn.js';
import { WrapSynthClient, secrets, accounts } from '../../client/client.js';
import { mintRequestPda, mintRequestId, burnRequestPda, burnRequestId } from '../../client/pdas.js';
import { sendAndConfirm } from '../../client/connection.js';

const CU = (u) => ComputeBudgetProgram.setComputeUnitLimit({ units: u });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const c = WrapSynthClient.fromDevnet(process.env.HOME + '/.config/solana/id.json');
const lp = c.payer;
const vaultPda = c.vaultPda(lp.publicKey);
const vaultCollateralEscrow = c.vaultCollateralEscrow(vaultPda);
const send = (tx, s) => sendAndConfirm(c.conn, tx, s);
const rpcIx = (b, s) => c.rpcIx(b, s);
const tokenBal = async (ata) =>
  BigInt((await getAccount(c.conn, ata, undefined, TOKEN_2022_PROGRAM_ID)).amount.toString());
const ataOf = (mint, owner) => getAssociatedTokenAddressSync(mint, owner, true, TOKEN_2022_PROGRAM_ID);
async function createAta(mint, owner, payer = lp) {
  const ata = ataOf(mint, owner);
  if (!(await c.conn.getAccountInfo(ata))) {
    await send(new Transaction().add(createAssociatedTokenAccountInstruction(
      payer.publicKey, ata, owner, mint, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID)), [payer]);
  }
  return ata;
}
const statusOf = async (pda) =>
  accounts.statusName((await c.fetchRetry(() => c.program.account.mintRequest.fetch(pda))).status);

// ── 1. LP vault setup (idempotent) ─────────────────────────────────────────
console.log('lp:', lp.publicKey.toBase58(), 'vault:', vaultPda.toBase58());
if (!(await c.conn.getAccountInfo(vaultPda))) {
  console.log('[vault] creating');
  const rentFloor = await c.conn.getMinimumBalanceForRentExemption(0);
  const createIx = await c.program.methods.createVault().accounts({
    lp: lp.publicKey, vault: vaultPda, globalState: c.globalState,
    systemProgram: SystemProgram.programId,
  }).instruction();
  await send(new Transaction().add(createIx, SystemProgram.transfer({
    fromPubkey: lp.publicKey, toPubkey: vaultCollateralEscrow, lamports: rentFloor })), [lp]);
  await rpcIx(c.program.methods.setVaultMarketMetrics(100, 50).accounts({
    lp: lp.publicKey, vault: vaultPda,
  }), []);
  await rpcIx(c.program.methods.depositCollateral(new BN('2000000000')).accounts({
    lp: lp.publicKey, vault: vaultPda, globalState: c.globalState,
    vaultCollateralEscrow, systemProgram: SystemProgram.programId,
  }), []);
  console.log('[vault] configured + 2 SOL deposited');
} else {
  const v = await c.fetchRetry(() => c.program.account.vault.fetch(vaultPda));
  console.log('[vault] exists — collateral:', v.collateralAmount.toString(), 'debt:', v.normalizedDebt.toString());
  if (v.collateralAmount.toString() === '0') {
    await rpcIx(c.program.methods.depositCollateral(new BN('2000000000')).accounts({
      lp: lp.publicKey, vault: vaultPda, globalState: c.globalState,
      vaultCollateralEscrow, systemProgram: SystemProgram.programId,
    }), []);
    console.log('[vault] deposited 2 SOL');
  }
}

// ── 2. User + mint initiation ──────────────────────────────────────────────
const user = Keypair.generate();
console.log('user:', user.publicKey.toBase58());
await send(new Transaction().add(SystemProgram.transfer({
  fromPubkey: lp.publicKey, toPubkey: user.publicKey, lamports: 0.05 * 1e9 })), [lp]);

const pr = c.pendingReturns(user.publicKey);
if (!(await c.conn.getAccountInfo(pr))) {
  await rpcIx(c.program.methods.initializePendingReturns().accounts({
    owner: user.publicKey, pendingReturns: pr, systemProgram: SystemProgram.programId,
  }), [user]);
}
const userWsxmrAta = await createAta(c.wsxmrMint, user.publicKey, lp);
await rpcIx(c.program.methods.setMinterWhitelist(user.publicKey, true).accounts({
  lp: lp.publicKey, vault: vaultPda }), []);

const userSecret = secrets.makeSecret();
const XMR_AMOUNT = 4n * 10n ** 12n;
const mintId = mintRequestId(
  user.publicKey, vaultPda, XMR_AMOUNT, userSecret.commitment,
  await c.nextNonce());
const mintPda = mintRequestPda(mintId, c.programId);
console.log('\n[mint] initiating 4 XMR →', mintPda.toBase58());
await rpcIx(c.program.methods.initiateMint(
  new BN(XMR_AMOUNT.toString()), Array.from(userSecret.commitment),
  Array.from(userSecret.pubKey), Array.from(mintId)
).accounts({
  initiator: user.publicKey, recipient: user.publicKey,
  vault: vaultPda, globalState: c.globalState, mintRequest: mintPda,
  griefingEscrow: lp.publicKey,
  initiatorPendingReturns: pr,
  ...c.oracleAccounts(), systemProgram: SystemProgram.programId,
}), [user]);
console.log('[mint] initiated — handing off to lp-server');

// ── 3. Watch the LP server drive: pending → keyProvided → ready ────────────
const waitStatus = async (want, timeoutS) => {
  for (let i = 0; i < timeoutS; i++) {
    await sleep(1000);
    const s = await statusOf(mintPda).catch(() => '?');
    if (s === want) return;
    if (i % 10 === 0) console.log(`  [${i}s] status: ${s} (want ${want})`);
    if (['completed', 'cancelled', 'keyCancelled'].includes(s) && s !== want)
      throw new Error('request resolved early: ' + s);
  }
  throw new Error(`timeout waiting for status ${want}`);
};

await waitStatus('keyProvided', 120);
console.log('[lp]  provide_lp_key landed');
await waitStatus('ready', 60);
console.log('[lp]  set_mint_ready landed (deposit verification skipped)');

// ── 4. User reveals → server finalizes ──────────────────────────────────────
await rpcIx(c.program.methods.revealSecret(Array.from(userSecret.secret))
  .preInstructions([CU(400_000)])
  .accounts({ caller: user.publicKey, mintRequest: mintPda }), [user]);
console.log('[user] secret revealed');
await waitStatus('completed', 60);
const bal = await tokenBal(userWsxmrAta);
console.log(`\n[mint] DONE — user received ${Number(bal) / 1e8} wsXMR (expect 3.96 after 1% fee)`);

// ── 5. Burn handshake: request → server proposes → user confirms → finalize ─
const BURN_WSXMR = 1n * 10n ** 8n;
const burnId = burnRequestId(user.publicKey, vaultPda, BURN_WSXMR, await c.nextNonce());
const burnPda = burnRequestPda(burnId, c.programId);
const burnStatusOf = async () =>
  accounts.statusName((await c.fetchRetry(() => c.program.account.burnRequest.fetch(burnPda))).status);
const waitBurnStatus = async (want, timeoutS) => {
  for (let i = 0; i < timeoutS; i++) {
    await sleep(1000);
    const s = await burnStatusOf().catch(() => '?');
    if (s === want) return;
    if (i % 10 === 0) console.log(`  [${i}s] burn status: ${s} (want ${want})`);
    if (['slashed', 'cancelled', 'completed'].includes(s) && s !== want)
      throw new Error('burn resolved early: ' + s);
  }
  throw new Error(`timeout waiting for burn status ${want}`);
};

console.log('\n[burn] requesting 1 wsXMR burn');
const userBurn = secrets.makeSecret();
await rpcIx(c.program.methods.requestBurn(
  new BN(BURN_WSXMR.toString()), Array.from(userBurn.commitment),
  Array.from(userBurn.pubKey), Array.from(userBurn.pubKey), Array.from(burnId))
  .accounts({
    user: user.publicKey, vault: vaultPda, globalState: c.globalState, burnRequest: burnPda,
    wsxmrMint: c.wsxmrMint, userWsxmrAta, ...c.oracleAccounts(),
    tokenProgram: TOKEN_2022_PROGRAM_ID, systemProgram: SystemProgram.programId,
  }), [user]);
console.log('[burn] requested — handing off to lp-server');

await waitBurnStatus('proposed', 120);
console.log('[lp]  propose_hash landed');

// Devnet: SKIP_BURN_XMR_SEND means no real XMR — user confirms blind.
await rpcIx(c.program.methods.confirmMoneroLock().accounts({
  user: user.publicKey, burnRequest: burnPda }), [user]);
console.log('[user] confirmed monero lock (devnet — no real XMR)');
await waitBurnStatus('completed', 60);

const v = await c.fetchRetry(() => c.program.account.vault.fetch(vaultPda));
const prAcct = await c.fetchRetry(() => c.program.account.pendingReturns.fetch(pr));
console.log(`\nDONE — debt: ${Number(v.normalizedDebt) / 1e8} wsXMR | collateral: ${Number(v.collateralAmount) / 1e9} | locked: ${v.lockedCollateral.toString()} | user pending returns: ${prAcct.collateralAmount.toString()}`);
