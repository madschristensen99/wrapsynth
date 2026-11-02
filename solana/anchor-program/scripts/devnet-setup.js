#!/usr/bin/env node
// devnet-setup.js — one-time devnet provisioning after `anchor deploy`.
//
//   node scripts/devnet-setup.js
//
// Creates (idempotently):
//   - rent-floor funding for the global lamport escrow PDAs
//   - protocol initialize (GlobalState, wsXMR mint)
// Collateral is native SOL — no stand-in mint, no ATAs needed.
// No oracle accounts: thresholds are LP-declared on-chain parameters.
// Writes devnet/devnet-config.json consumed by the LP server and frontend.
"use strict";

const fs = require("fs");
const path = require("path");
const {
  Keypair, PublicKey, SystemProgram, Transaction, LAMPORTS_PER_SOL,
  SYSVAR_RENT_PUBKEY,
} = require("@solana/web3.js");
const { TOKEN_2022_PROGRAM_ID } = require("@solana/spl-token");
const L = require("./devnet-lib");

async function send(tx, signers) {
  const sig = await L.conn.sendTransaction(tx, signers);
  await confirm(sig);
  return sig;
}

// HTTP-poll confirmation — avoids websocket subs that die under devnet 429s.
async function confirm(sig, timeoutMs = 60_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const st = await L.conn.getSignatureStatuses([sig]);
    const v = st?.value?.[0];
    if (v?.err) throw new Error("tx failed: " + JSON.stringify(v.err));
    if (v?.confirmationStatus === "confirmed" || v?.confirmationStatus === "finalized") return;
    await new Promise((r) => setTimeout(r, 1200));
  }
  throw new Error("confirmation timeout: " + sig);
}

async function main() {
  const admin = L.adminKeypair();
  const conn = L.conn;
  console.log("admin:", admin.publicKey.toBase58());
  console.log("balance:", (await conn.getBalance(admin.publicKey)) / LAMPORTS_PER_SOL, "SOL");

  const program = L.loadProgram(admin);

  // Sanity: the program must be deployed
  {
    const info = await conn.getAccountInfo(L.PROGRAM_ID);
    if (!info || !info.executable) throw new Error(`vault-manager not deployed at ${L.PROGRAM_ID.toBase58()}`);
  }

  const collateralEscrow = L.findPda([L.PROGRAM_COLLATERAL_SEED]);

  // ── 1. Rent-floor funding for lamport escrows ────────────────────────────
  // A data-less PDA left with (0, rentMin) lamports violates rent — floor-fund
  // the global escrows once; tracked deposits/withdrawals sit on top.
  {
    const rentFloor = await conn.getMinimumBalanceForRentExemption(0);
    const fundTx = new Transaction();
    for (const pda of [collateralEscrow, L.findPda([L.SOL_ESCROW_SEED])]) {
      const info = await conn.getAccountInfo(pda);
      if ((info?.lamports ?? 0) < rentFloor)
        fundTx.add(SystemProgram.transfer({
          fromPubkey: admin.publicKey, toPubkey: pda, lamports: rentFloor }));
    }
    if (fundTx.instructions.length) {
      await send(fundTx, [admin]);
      console.log("rent floor funded:", rentFloor, "lamports → escrows");
    }
  }

  // ── 2. Protocol initialize ───────────────────────────────────────────────
  const globalState = L.findPda([L.GLOBAL_STATE_SEED]);
  const wsxmrMint = L.findPda([L.WSXMR_MINT_SEED]);
  if (!(await conn.getAccountInfo(globalState))) {
    await L.rpcIx(
      program.methods
        .initialize()
        .accounts({
          authority: admin.publicKey,
          globalState,
          wsxmrMint,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: SYSVAR_RENT_PUBKEY,
        }),
      [], admin
    );
    console.log("initialized. wsXMR mint:", wsxmrMint.toBase58());
  } else {
    console.log("already initialized. wsXMR mint:", wsxmrMint.toBase58());
  }

  // ── 3. Emit config ───────────────────────────────────────────────────────
  const config = {
    cluster: "devnet",
    rpc: L.DEVNET_URL,
    programId: L.PROGRAM_ID.toBase58(),
    globalState: globalState.toBase58(),
    wsxmrMint: wsxmrMint.toBase58(),
    // Native SOL collateral — wSOL mint is the SPL identity (used by co-LP)
    collateralMint: "So11111111111111111111111111111111111111112",
    collateralEscrow: collateralEscrow.toBase58(),
    solEscrow: L.findPda([L.SOL_ESCROW_SEED]).toBase58(),
    authority: admin.publicKey.toBase58(),
    seeds: {
      globalState: "global_state", wsxmrMint: "wsxmr_mint",
      programCollateral: "program_collateral", vault: "vault",
      vaultCollateral: "vault_collateral", pendingReturns: "pending_returns",
      mintRequest: "mint_request", burnRequest: "burn_request", solEscrow: "sol_escrow",
      auction: "auction", auctionBond: "auction_bond",
    },
    generatedAt: new Date().toISOString(),
  };
  const out = path.join(L.KEY_DIR, "devnet-config.json");
  fs.mkdirSync(L.KEY_DIR, { recursive: true });
  fs.writeFileSync(out, JSON.stringify(config, null, 2));
  console.log("\nwrote", out);
  console.log(JSON.stringify(config, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
