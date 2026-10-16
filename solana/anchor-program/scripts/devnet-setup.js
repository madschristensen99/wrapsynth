#!/usr/bin/env node
// devnet-setup.js — one-time devnet provisioning after `anchor deploy`.
//
//   node scripts/devnet-setup.js
//
// Creates (idempotently):
//   - two mock Pyth price accounts owned by oracle-mock (XMR/USD, SOL/USD)
//   - initial price writes ($15 XMR, $150 SOL)
//   - protocol initialize (GlobalState, wsXMR mint)
// Collateral is native SOL — no stand-in mint, no ATAs needed.
// Writes devnet/devnet-config.json consumed by the LP server, frontend,
// and the oracle refresher.
"use strict";

const fs = require("fs");
const path = require("path");
const {
  Connection, Keypair, PublicKey, SystemProgram, Transaction, LAMPORTS_PER_SOL,
  SYSVAR_RENT_PUBKEY,
} = require("@solana/web3.js");
const { TOKEN_2022_PROGRAM_ID } = require("@solana/spl-token");
const anchor = require("@coral-xyz/anchor");
const L = require("./devnet-lib");

const XMR_USD = 15n;
const SOL_USD = 150n;
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
  const oracleXmrKp = kp("oracle-xmr.json");
  const oracleSolKp = kp("oracle-sol.json");

  // ── 2. Mock oracle accounts (owned by oracle-mock) ────────────────────────
  const rentO = await conn.getMinimumBalanceForRentExemption(ORACLE_SPACE);
  for (const [name, okp] of [["xmr", oracleXmrKp], ["sol", oracleSolKp]]) {
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
  await L.writeOracle(oracleMock, admin, oracleSolKp.publicKey, L.SOL_FEED_ID, SOL_USD);
  console.log(`oracles written: XMR $${XMR_USD}, SOL $${SOL_USD}`);

  const collateralEscrow = L.findPda([L.PROGRAM_COLLATERAL_SEED]);

  // ── 4. Rent-floor funding for lamport escrows ────────────────────────────
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

  // ── 5. Protocol initialize ───────────────────────────────────────────────
  const globalState = L.findPda([L.GLOBAL_STATE_SEED]);
  const wsxmrMint = L.findPda([L.WSXMR_MINT_SEED]);
  if (!(await conn.getAccountInfo(globalState))) {
    await L.rpcIx(
      program.methods
        .initialize(oracleXmrKp.publicKey)
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

  // ── 6. Emit config ───────────────────────────────────────────────────────
  const config = {
    cluster: "devnet",
    rpc: L.DEVNET_URL,
    programId: L.PROGRAM_ID.toBase58(),
    oracleMockProgramId: L.ORACLE_MOCK_ID.toBase58(),
    globalState: globalState.toBase58(),
    wsxmrMint: wsxmrMint.toBase58(),
    // Native SOL collateral — wSOL mint is the SPL identity (used by co-LP)
    collateralMint: "So11111111111111111111111111111111111111112",
    collateralEscrow: collateralEscrow.toBase58(),
    solEscrow: L.findPda([L.SOL_ESCROW_SEED]).toBase58(),
    oracle: {
      xmr: oracleXmrKp.publicKey.toBase58(),
      sol: oracleSolKp.publicKey.toBase58(),
      xmrFeedId: "0x" + L.XMR_FEED_ID.toString("hex"),
      solFeedId: "0x" + L.SOL_FEED_ID.toString("hex"),
      note: "MOCKED — owned by oracle-mock, refreshed by scripts/oracle-refresh.js. NOT real Pyth.",
    },
    authority: admin.publicKey.toBase58(),
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
