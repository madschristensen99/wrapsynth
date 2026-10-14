#!/usr/bin/env node
// devnet-setup.js — one-time devnet provisioning after `anchor deploy`.
//
//   node scripts/devnet-setup.js
//
// Creates (idempotently):
//   - stand-in QQQx collateral mint (Token-2022, 8 decimals, admin authority)
//   - two mock Pyth price accounts owned by oracle-mock (XMR/USD, QQQX/USD)
//   - initial price writes ($15 XMR, $600 QQQX)
//   - protocol initialize (GlobalState, wsXMR mint, program collateral ATA)
// Writes devnet/devnet-config.json consumed by the LP server, frontend,
// and the oracle refresher.
"use strict";

const fs = require("fs");
const path = require("path");
const {
  Connection, Keypair, PublicKey, SystemProgram, Transaction, LAMPORTS_PER_SOL,
  SYSVAR_RENT_PUBKEY,
} = require("@solana/web3.js");
const {
  TOKEN_2022_PROGRAM_ID, getMintLen, createInitializeMint2Instruction,
  createAssociatedTokenAccountInstruction, createMintToInstruction,
  getAssociatedTokenAddressSync,
} = require("@solana/spl-token");
const anchor = require("@coral-xyz/anchor");
const L = require("./devnet-lib");

const XMR_USD = 15n;
const QQQX_USD = 600n;
const ORACLE_SPACE = 200;

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
  const oracleMock = L.loadOracleMock(admin);

  // Sanity: both programs must be deployed
  for (const [name, id] of [["vault-manager", L.PROGRAM_ID], ["oracle-mock", L.ORACLE_MOCK_ID]]) {
    const info = await conn.getAccountInfo(id);
    if (!info || !info.executable) throw new Error(`${name} not deployed at ${id.toBase58()}`);
  }

  const kp = (f) => L.keypairOrNew(f);
  const collateralMintKp = kp("collateral-mint.json");
  const oracleXmrKp = kp("oracle-xmr.json");
  const oracleQqqxKp = kp("oracle-qqqx.json");

  // ── 1. Stand-in collateral mint (Token-2022, 8 decimals) ─────────────────
  const collateralMint = collateralMintKp.publicKey;
  if (!(await conn.getAccountInfo(collateralMint))) {
    const rent = await conn.getMinimumBalanceForRentExemption(getMintLen([]));
    const tx = new Transaction().add(
      SystemProgram.createAccount({
        fromPubkey: admin.publicKey,
        newAccountPubkey: collateralMint,
        space: getMintLen([]),
        lamports: rent,
        programId: TOKEN_2022_PROGRAM_ID,
      }),
      createInitializeMint2Instruction(
        collateralMint, 8, admin.publicKey, null, TOKEN_2022_PROGRAM_ID
      )
    );
    await send(tx, [admin, collateralMintKp]);
    console.log("created collateral mint:", collateralMint.toBase58());
  } else {
    console.log("collateral mint exists:", collateralMint.toBase58());
  }

  // ── 2. Mock oracle accounts (owned by oracle-mock) ────────────────────────
  const rentO = await conn.getMinimumBalanceForRentExemption(ORACLE_SPACE);
  for (const [name, okp] of [["xmr", oracleXmrKp], ["qqqx", oracleQqqxKp]]) {
    if (!(await conn.getAccountInfo(okp.publicKey))) {
      const tx = new Transaction().add(
        SystemProgram.createAccount({
          fromPubkey: admin.publicKey,
          newAccountPubkey: okp.publicKey,
          space: ORACLE_SPACE,
          lamports: rentO,
          programId: L.ORACLE_MOCK_ID,
        })
      );
      await send(tx, [admin, okp]);
      console.log(`created ${name} oracle account:`, okp.publicKey.toBase58());
    } else {
      console.log(`${name} oracle exists:`, okp.publicKey.toBase58());
    }
  }

  // ── 3. Initial price writes ──────────────────────────────────────────────
  await L.writeOracle(oracleMock, admin, oracleXmrKp.publicKey, L.XMR_FEED_ID, XMR_USD);
  await L.writeOracle(oracleMock, admin, oracleQqqxKp.publicKey, L.QQQX_FEED_ID, QQQX_USD);
  console.log(`oracles written: XMR $${XMR_USD}, QQQX $${QQQX_USD}`);

  // ── 4. Protocol initialize ───────────────────────────────────────────────
  const globalState = L.findPda([L.GLOBAL_STATE_SEED]);
  const wsxmrMint = L.findPda([L.WSXMR_MINT_SEED]);
  const programCollateralAta = L.findPda([L.PROGRAM_COLLATERAL_SEED]);
  if (!(await conn.getAccountInfo(globalState))) {
    await program.methods
      .initialize(oracleXmrKp.publicKey, collateralMint)
      .accounts({
        authority: admin.publicKey,
        globalState,
        wsxmrMint,
        collateralMint,
        programCollateralAta,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .signers([admin])
      .rpc();
    console.log("initialized. wsXMR mint:", wsxmrMint.toBase58());
  } else {
    console.log("already initialized. wsXMR mint:", wsxmrMint.toBase58());
  }

  // ── 5. Admin collateral ATA + faucet supply ──────────────────────────────
  const adminCollateralAta = getAssociatedTokenAddressSync(
    collateralMint, admin.publicKey, true, TOKEN_2022_PROGRAM_ID
  );
  if (!(await conn.getAccountInfo(adminCollateralAta))) {
    const tx = new Transaction().add(
      createAssociatedTokenAccountInstruction(
        admin.publicKey, adminCollateralAta, admin.publicKey,
        collateralMint, TOKEN_2022_PROGRAM_ID
      ),
      createMintToInstruction(
        collateralMint, adminCollateralAta, admin.publicKey,
        1_000_000_0000_0000n, // 1M tokens — devnet faucet supply
        [], TOKEN_2022_PROGRAM_ID
      )
    );
    await send(tx, [admin]);
    console.log("admin collateral ATA funded:", adminCollateralAta.toBase58());
  }

  // ── 6. Emit config ───────────────────────────────────────────────────────
  const config = {
    cluster: "devnet",
    rpc: L.DEVNET_URL,
    programId: L.PROGRAM_ID.toBase58(),
    oracleMockProgramId: L.ORACLE_MOCK_ID.toBase58(),
    globalState: globalState.toBase58(),
    wsxmrMint: wsxmrMint.toBase58(),
    collateralMint: collateralMint.toBase58(),
    programCollateralAta: programCollateralAta.toBase58(),
    solEscrow: L.findPda([L.SOL_ESCROW_SEED]).toBase58(),
    oracle: {
      xmr: oracleXmrKp.publicKey.toBase58(),
      qqqx: oracleQqqxKp.publicKey.toBase58(),
      xmrFeedId: "0x" + L.XMR_FEED_ID.toString("hex"),
      qqqxFeedId: "0x" + L.QQQX_FEED_ID.toString("hex"),
      note: "MOCKED — owned by oracle-mock, refreshed by scripts/oracle-refresh.js. NOT real Pyth.",
    },
    authority: admin.publicKey.toBase58(),
    adminCollateralAta: adminCollateralAta.toBase58(),
    seeds: {
      globalState: "global_state", wsxmrMint: "wsxmr_mint",
      programCollateral: "program_collateral", vault: "vault",
      vaultCollateral: "vault_collateral", pendingReturns: "pending_returns",
      mintRequest: "mint_request", burnRequest: "burn_request", solEscrow: "sol_escrow",
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
