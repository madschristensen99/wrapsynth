#!/usr/bin/env node
// oracle-refresh.js — devnet oracle refresher daemon.
//
//   node scripts/oracle-refresh.js [--xmr 15] [--qqqx 600] [--interval 60]
//
// The vault program rejects oracle reads older than PRICE_MAX_AGE (120s), so
// on devnet the mock feeds must be rewritten continuously. Run this in tmux /
// pm2 / a side shell while testing. Every cycle it rewrites both price blobs
// with publish_time = current devnet clock.
//
// To simulate price moves for liquidation testing, send SIGUSR1 to drop QQQX
// to $200, SIGUSR2 to restore $600 — or just restart with --qqqx 200.
"use strict";

const fs = require("fs");
const path = require("path");
const L = require("./devnet-lib");

const arg = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : dflt;
};
let xmrUsd = BigInt(arg("--xmr", "15"));
let qqqxUsd = BigInt(arg("--qqqx", "600"));
const intervalMs = Number(arg("--interval", "60")) * 1000;

process.on("SIGUSR1", () => { qqqxUsd = 200n; console.log(`[oracle] QQQX crashed -> $${qqqxUsd}`); });
process.on("SIGUSR2", () => { qqqxUsd = 600n; console.log(`[oracle] QQQX restored -> $${qqqxUsd}`); });

const config = JSON.parse(
  fs.readFileSync(path.join(L.KEY_DIR, "devnet-config.json"), "utf8")
);
const XMR_ACCT = new (require("@solana/web3.js").PublicKey)(config.oracle.xmr);
const QQQX_ACCT = new (require("@solana/web3.js").PublicKey)(config.oracle.qqqx);

async function tick() {
  const admin = L.adminKeypair();
  const oracleMock = L.loadOracleMock(admin);
  try {
    await L.writeOracle(oracleMock, admin, XMR_ACCT, L.XMR_FEED_ID, xmrUsd);
    await L.writeOracle(oracleMock, admin, QQQX_ACCT, L.QQQX_FEED_ID, qqqxUsd);
    console.log(`[oracle] ${new Date().toISOString()} XMR=$${xmrUsd} QQQX=$${qqqxUsd}`);
  } catch (e) {
    console.error(`[oracle] write failed: ${e.message ?? e}`);
  }
}

(async () => {
  console.log(`oracle-refresh: pid ${process.pid}, every ${intervalMs / 1000}s`);
  console.log(`  XMR acct:  ${XMR_ACCT.toBase58()}`);
  console.log(`  QQQX acct: ${QQQX_ACCT.toBase58()}`);
  console.log(`  SIGUSR1 = crash QQQX to $200 | SIGUSR2 = restore $600`);
  await tick();
  setInterval(tick, intervalMs);
})();
