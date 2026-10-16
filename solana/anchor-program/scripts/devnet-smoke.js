#!/usr/bin/env node
// devnet-smoke.js — end-to-end smoke test against the devnet deployment.
//
//   node scripts/devnet-smoke.js
//
// Drives the full atomic-swap flow the LP server + frontend will implement:
//   create vault -> deposit -> whitelist -> mint handshake -> burn handshake
//   -> withdraw pending returns
//
// This file is ALSO the reference implementation for client conventions:
//   - request_id = keccak(initiator, vault, xmr_amount, commitment, nonce) for
//     mints; keccak(user, vault, wsxmr_amount, nonce) for burns, where nonce =
//     global.request_nonce + 1 at call time (read it fresh per request)
//   - Ed25519 secrets must be canonical scalars (< group order L): mask
//     secret[31] &= 0x0f or the on-chain curve syscall rejects them
//   - use the same commitment level for sends and reads (the localnet suite
//     lost a day to processed-vs-confirmed read skew)
//   - Token-2022 ATAs only; Ed25519-heavy instructions need compute bumps
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { keccak_256 } = require("@noble/hashes/sha3");
const { Point } = require("@noble/ed25519");
const {
  PublicKey, SystemProgram, Transaction, ComputeBudgetProgram, Keypair, LAMPORTS_PER_SOL,
} = require("@solana/web3.js");
const {
  TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountInstruction, getAssociatedTokenAddressSync, getAccount,
} = require("@solana/spl-token");
const anchor = require("@coral-xyz/anchor");
const L = require("./devnet-lib");

const cfg = JSON.parse(fs.readFileSync(path.join(L.KEY_DIR, "devnet-config.json"), "utf8"));
const admin = L.adminKeypair();
const conn = L.conn;
const program = L.loadProgram(admin);

// ─── conventions the LP server/frontend must mirror ─────────────────────────
const ED25519_L = 2n ** 252n + 27742317777372353535851937790883648493n;
const leScalar = (s) => {
  let x = 0n;
  for (let i = 0; i < 32; i++) x |= BigInt(s[i]) << BigInt(i * 8);
  return x % ED25519_L;
};
const pubKeyOf = (s) => Buffer.from(Point.BASE.multiply(leScalar(s)).toRawBytes());
const commitmentOf = (s) => Buffer.from(keccak_256(pubKeyOf(s)));
function makeSecret() {
  const secret = crypto.randomBytes(32);
  secret[31] &= 0x0f; // canonical scalar — REQUIRED or on-chain mul_verify rejects
  return { secret, commitment: commitmentOf(secret), pubKey: pubKeyOf(secret) };
}
const le64 = (v) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(v); return b; };
const mintRequestId = (initiator, vault, xmrAmt, commitment, nonce) =>
  Buffer.from(keccak_256(Buffer.concat([initiator.toBuffer(), vault.toBuffer(), le64(xmrAmt), commitment, le64(nonce)])));
const burnRequestId = (user, vault, wsxmrAmt, nonce) =>
  Buffer.from(keccak_256(Buffer.concat([user.toBuffer(), vault.toBuffer(), le64(wsxmrAmt), le64(nonce)])));

const globalState = new PublicKey(cfg.globalState);
const wsxmrMint = new PublicKey(cfg.wsxmrMint);
const collateralEscrow = new PublicKey(cfg.collateralEscrow);
const PYTH_XMR = new PublicKey(cfg.oracle.xmr);
const PYTH_COL = new PublicKey(cfg.oracle.sol);
const CU = (u) => ComputeBudgetProgram.setComputeUnitLimit({ units: u });

const tokenBal = async (ata) =>
  BigInt((await getAccount(conn, ata, undefined, TOKEN_2022_PROGRAM_ID)).amount.toString());
const ataOf = (mint, owner) => getAssociatedTokenAddressSync(mint, owner, true, TOKEN_2022_PROGRAM_ID);
async function createAta(mint, owner, payer = admin) {
  const ata = ataOf(mint, owner);
  if (!(await conn.getAccountInfo(ata))) {
    const tx = new Transaction().add(createAssociatedTokenAccountInstruction(
      payer.publicKey, ata, owner, mint, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID));
    await send(tx, [payer]);
  }
  return ata;
}
async function fetchRetry(fn, tries = 8) {
  for (let i = 0; i < tries; i++) {
    try { return await fn(); }
    catch (e) {
      if (i === tries - 1) throw e;
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}
const reqNonce = async () =>
  BigInt((await fetchRetry(() => program.account.globalState.fetch(globalState))).requestNonce.toString());

const send = L.sendAndConfirm;
const rpcIx = (builder, signers) => L.rpcIx(builder, signers, admin);

async function main() {
  const lp = Keypair.generate();
  const user = Keypair.generate();
  console.log("lp:", lp.publicKey.toBase58());
  console.log("user:", user.publicKey.toBase58());

  // Fund the test actors (devnet SOL + collateral from admin faucet)
  await send(new Transaction().add(
    SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: lp.publicKey, lamports: 2.5 * LAMPORTS_PER_SOL }),
    SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: user.publicKey, lamports: 0.05 * LAMPORTS_PER_SOL }),
  ), [admin]);

  const vaultPda = L.findPda([L.VAULT_SEED, lp.publicKey.toBuffer()]);
  const vaultCollateralEscrow = L.findPda([L.VAULT_COLLATERAL_SEED, vaultPda.toBuffer()]);
  const pendingOf = (owner) => L.findPda([L.PENDING_RETURNS_SEED, owner.toBuffer()]);

  // ── Vault: create -> configure -> escrow floor -> deposit SOL ────────────
  console.log("\n[vault] create + configure");
  const rentFloor = await conn.getMinimumBalanceForRentExemption(0);
  await send(new Transaction().add(
    await program.methods.createVault().accounts({
      lp: lp.publicKey, vault: vaultPda, globalState, systemProgram: SystemProgram.programId,
    }).instruction(),
    // floor-fund the vault's SOL escrow — sub-rent balances on a data-less
    // PDA violate rent; tracked deposits/withdrawals sit on top
    SystemProgram.transfer({ fromPubkey: admin.publicKey, toPubkey: vaultCollateralEscrow, lamports: rentFloor }),
  ), [admin, lp]);
  await rpcIx(program.methods.setVaultMarketMetrics(100, 50).accounts({
    lp: lp.publicKey, vault: vaultPda,
  }), [lp]); // 1% mint fee, 0.5% burn reward

  await rpcIx(program.methods.depositCollateral(new anchor.BN("2000000000")).accounts({ // 2 SOL = $300
    lp: lp.publicKey, vault: vaultPda, globalState,
    vaultCollateralEscrow, systemProgram: SystemProgram.programId,
  }), [lp]);
  console.log("[vault] deposited 2 SOL");

  for (const owner of [lp, user]) {
    const pr = pendingOf(owner.publicKey);
    if (!(await conn.getAccountInfo(pr))) {
      await rpcIx(program.methods.initializePendingReturns().accounts({
        owner: owner.publicKey, pendingReturns: pr, systemProgram: SystemProgram.programId,
      }), [owner]);
    }
  }
  await rpcIx(program.methods.setMinterWhitelist(user.publicKey, true).accounts({
    lp: lp.publicKey, vault: vaultPda,
  }), [lp]);

  // ── Mint handshake: initiate -> provide_lp_key -> set_mint_ready -> reveal -> finalize
  console.log("\n[mint] 4 wsXMR request");
  const mint1 = makeSecret(), lpKey = makeSecret();
  const XMR_AMOUNT = 4n * 10n ** 12n;      // 4 XMR = 4 wsXMR = $60 @ $15
  const WSXMR_AMOUNT = XMR_AMOUNT / 10_000n;
  const mintId = mintRequestId(user.publicKey, vaultPda, XMR_AMOUNT, mint1.commitment, await reqNonce() + 1n);
  const mintPda = L.findPda([L.MINT_REQUEST_SEED, mintId]);

  await rpcIx(program.methods.initiateMint(
    new anchor.BN(XMR_AMOUNT.toString()), Array.from(mint1.commitment),
    Array.from(mint1.pubKey), Array.from(mintId)
  ).accounts({
    initiator: user.publicKey, recipient: user.publicKey,
    vault: vaultPda, globalState, mintRequest: mintPda,
    griefingEscrow: admin.publicKey,
    initiatorPendingReturns: pendingOf(user.publicKey),
    pythXmr: PYTH_XMR, pythCollateral: PYTH_COL,
    systemProgram: SystemProgram.programId,
  }), [user]);
  console.log("[mint] initiated");

  await rpcIx(program.methods.provideLpKey(
    Array.from(lpKey.pubKey), Array.from(lpKey.pubKey), Array.from(lpKey.commitment)
  ).accounts({
    lp: lp.publicKey, vault: vaultPda, globalState, mintRequest: mintPda,
    pythXmr: PYTH_XMR, pythCollateral: PYTH_COL,
  }), [lp]);
  console.log("[mint] LP keys provided (this is the LP-server tx)");

  await rpcIx(program.methods.setMintReady().accounts({
    lp: lp.publicKey, vault: vaultPda, globalState, mintRequest: mintPda,
    pythXmr: PYTH_XMR, pythCollateral: PYTH_COL,
  }), [lp]);
  console.log("[mint] marked ready (LP locked Monero off-chain)");

  await rpcIx(program.methods.revealSecret(Array.from(mint1.secret))
    .preInstructions([CU(400_000)])
    .accounts({ caller: user.publicKey, mintRequest: mintPda }), [user]);
  console.log("[mint] user revealed secret");

  const userWsxmrAta = await createAta(wsxmrMint, user.publicKey);
  const lpWsxmrAta = await createAta(wsxmrMint, lp.publicKey);
  await rpcIx(program.methods.finalizeMint()
    .preInstructions([CU(400_000)])
    .accounts({
      caller: lp.publicKey, vaultLp: lp.publicKey, vault: vaultPda, globalState,
      mintRequest: mintPda,
      wsxmrMint, recipientWsxmrAta: userWsxmrAta, lpWsxmrAta,
      pendingReturns: pendingOf(user.publicKey),
      vaultCollateralEscrow, collateralEscrow,
      tokenProgram: TOKEN_2022_PROGRAM_ID, systemProgram: SystemProgram.programId,
    }), [lp]);
  const userBal = await tokenBal(userWsxmrAta);
  console.log(`[mint] finalized — user wsXMR balance: ${Number(userBal) / 1e8}`);

  // ── Burn handshake: request -> propose_hash -> confirm -> finalize ────────
  console.log("\n[burn] 1 wsXMR burn request");
  const burn1 = makeSecret(), lpBurn = makeSecret();
  const BURN_WSXMR = 1_0000_0000n;
  const burnId = burnRequestId(user.publicKey, vaultPda, BURN_WSXMR, await reqNonce() + 1n);
  const burnPda = L.findPda([L.BURN_REQUEST_SEED, burnId]);

  await rpcIx(program.methods.requestBurn(
    new anchor.BN(BURN_WSXMR.toString()), Array.from(burn1.commitment),
    Array.from(burn1.pubKey), Array.from(burn1.pubKey), Array.from(burnId)
  ).accounts({
    user: user.publicKey, vault: vaultPda, globalState, burnRequest: burnPda,
    wsxmrMint, userWsxmrAta, pythXmr: PYTH_XMR, pythCollateral: PYTH_COL,
    tokenProgram: TOKEN_2022_PROGRAM_ID, systemProgram: SystemProgram.programId,
  }), [user]);
  console.log("[burn] requested — wsXMR burned, collateral locked");

  await rpcIx(program.methods.proposeHash(
    Array.from(lpBurn.commitment), Array.from(lpBurn.pubKey), Array.from(lpBurn.pubKey)
  ).accounts({
    lp: lp.publicKey, vault: vaultPda, burnRequest: burnPda,
  }), [lp]);
  console.log("[burn] LP proposed hash (LP-server tx — user locks XMR off-chain next)");

  await rpcIx(program.methods.confirmMoneroLock().accounts({
    user: user.publicKey, burnRequest: burnPda,
  }), [user]);
  console.log("[burn] user confirmed Monero lock");

  await rpcIx(program.methods.finalizeBurn(Array.from(lpBurn.secret))
    .preInstructions([CU(400_000)])
    .accounts({
      caller: lp.publicKey, vaultLp: lp.publicKey, vault: vaultPda, globalState,
      burnRequest: burnPda, userPendingReturns: pendingOf(user.publicKey),
      pythXmr: PYTH_XMR, pythCollateral: PYTH_COL,
      vaultCollateralEscrow, collateralEscrow,
      tokenProgram: TOKEN_2022_PROGRAM_ID, systemProgram: SystemProgram.programId,
    }), [lp]);
  console.log("[burn] finalized — reward credited to user pending returns");

  // ── Withdraw pending returns (native SOL) ────────────────────────────────
  const prBefore = await fetchRetry(() => program.account.pendingReturns.fetch(pendingOf(user.publicKey)));
  await rpcIx(program.methods.withdrawCollateralReturns().accounts({
    owner: user.publicKey, pendingReturns: pendingOf(user.publicKey), globalState,
    collateralEscrow, systemProgram: SystemProgram.programId,
  }), [user]);
  console.log(`[withdraw] claimed ${Number(prBefore.collateralAmount.toString()) / 1e9} SOL`);

  const v = await fetchRetry(() => program.account.vault.fetch(vaultPda));
  console.log("\nDONE. Vault debt:", v.normalizedDebt.toString(),
    "| collateral:", v.collateralAmount.toString(), "| locked:", v.lockedCollateral.toString());
}

main().catch((e) => { console.error("\nFAILED:", e.message ?? e); process.exit(1); });
