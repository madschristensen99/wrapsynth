#!/usr/bin/env node
// gen-mock-pyth.js
// Generates fresh mock Pyth PriceUpdateV2 account JSON files in tests/fixtures/
// so solana-test-validator can pre-load them via Anchor.toml [[test.validator.account]].
// Run this as the "pretest" npm hook so publish_time is always fresh.
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const FIXTURES = path.join(ROOT, "tests", "fixtures");
fs.mkdirSync(FIXTURES, { recursive: true });

// Read stable keypairs from fixtures
function loadPubkey(file) {
  const kp = JSON.parse(fs.readFileSync(path.join(FIXTURES, file), "utf8"));
  // Solana keypair JSON: [private..., public...] — last 32 bytes are pubkey
  // Actually it's the full 64-byte secret key; pubkey = bytes 32..64
  const { PublicKey } = require(path.join(ROOT, "node_modules", "@solana", "web3.js"));
  const { Keypair } = require(path.join(ROOT, "node_modules", "@solana", "web3.js"));
  return Keypair.fromSecretKey(Uint8Array.from(kp)).publicKey.toBase58();
}

const xmrPubkey = loadPubkey("pyth_xmr_keypair.json");
const colPubkey = loadPubkey("pyth_col_keypair.json");
const rrPubkey = loadPubkey("pyth_rr_keypair.json");

// XMR/USD feed ID from constants.rs
const XMR_FEED_ID = Buffer.from([
  0x46, 0xb8, 0xcc, 0x93, 0x47, 0xf0, 0x43, 0x91,
  0x76, 0x4a, 0x03, 0x61, 0xe0, 0xb1, 0x7c, 0x3b,
  0xa3, 0x94, 0xb0, 0x01, 0xe7, 0xc3, 0x04, 0xf7,
  0x65, 0x0f, 0x63, 0x76, 0xe3, 0x7c, 0x32, 0x1d,
]);

// Collateral feed ID must equal SUSDE_USD_FEED_ID in constants.rs —
// get_collateral_price() validates parsed.feed_id == SUSDE_USD_FEED_ID.
const COL_FEED_ID = Buffer.from([
  0xca, 0x3b, 0xa9, 0xa6, 0x19, 0xa4, 0xb3, 0x75,
  0x5c, 0x10, 0xac, 0x7d, 0x5e, 0x76, 0x02, 0x75,
  0xaa, 0x95, 0xe9, 0x82, 0x3d, 0x38, 0xa8, 0x4f,
  0xed, 0xd4, 0x16, 0x85, 0x6c, 0xdb, 0xa3, 0x7c,
]);

// sUSDe→USDe redemption-rate feed ID — must equal SUSDE_USDE_RR_FEED_ID in
// constants.rs. get_collateral_redemption_rate() validates against it.
const RR_FEED_ID = Buffer.from([
  0x27, 0x1c, 0x64, 0xce, 0x45, 0x99, 0x37, 0xab,
  0xf7, 0x21, 0xd4, 0x25, 0x52, 0x03, 0x57, 0x13,
  0xb6, 0xc5, 0x8f, 0x80, 0xee, 0xce, 0xab, 0x71,
  0x6a, 0x62, 0x46, 0x07, 0xfd, 0xa4, 0xb1, 0x0f,
]);

// Pyth PriceUpdateV2 layout (200 bytes total, 134 min):
// [0..8]   disc
// [8..40]  write_authority
// [40..42] verification_level
// [42..74] feed_id
// [74..82] price (i64 LE)
// [82..90] conf (u64 LE)
// [90..94] exponent (i32 LE)
// [94..102] publish_time (i64 LE)
// [102..110] prev_publish_time (i64 LE)
// [110..118] ema_price (i64 LE)
// [118..126] ema_conf (u64 LE)
// [126..134] posted_slot (u64 LE)
function buildPythAccount(feedId, priceRaw, emaRaw, exponent, publishTime) {
  const buf = Buffer.alloc(200, 0);
  // PriceUpdateV2 discriminator = sha256("account:PriceUpdateV2")[0..8]
  Buffer.from([0xc8, 0x8c, 0x29, 0x47, 0x6e, 0x23, 0x15, 0x1c]).copy(buf, 0);
  feedId.copy(buf, 42);
  buf.writeBigInt64LE(BigInt(priceRaw), 74);
  buf.writeBigUInt64LE(BigInt(priceRaw) / 1000n, 82);
  buf.writeInt32LE(exponent, 90);
  buf.writeBigInt64LE(BigInt(publishTime), 94);
  buf.writeBigInt64LE(BigInt(publishTime) - 10n, 102);
  buf.writeBigInt64LE(BigInt(emaRaw), 110);
  buf.writeBigUInt64LE(BigInt(emaRaw) / 1000n, 118);
  return buf;
}

function toAccountJson(pubkey, data, lamports) {
  return {
    pubkey,
    account: {
      lamports,
      data: [data.toString("base64"), "base64"],
      owner: "11111111111111111111111111111111",
      executable: false,
      rentEpoch: 0,
      space: data.length,
    },
  };
}

const nowTs = Math.floor(Date.now() / 1000);
const lamports = 2_000_000_000;

// XMR = $15 (exp -8 → 1_500_000_000) — avoids u64 overflow in normalization
const xmrData = buildPythAccount(XMR_FEED_ID, 1_500_000_000, 1_500_000_000, -8, nowTs);
// Collateral = $1.05 (exp -8 → 105_000_000) — must satisfy the depeg guard
// (susde_market_price >= redemption_rate * 0.97); keeps >= the RR feed's 1.05.
const colData = buildPythAccount(COL_FEED_ID, 105_000_000, 105_000_000, -8, nowTs);
// sUSDe→USDe redemption rate = 1.05 (exp -8 → 105_000_000)
const rrData = buildPythAccount(RR_FEED_ID, 105_000_000, 105_000_000, -8, nowTs);

// Write to tests/fixtures/ with stable names for Anchor.toml reference
const xmrFile = path.join(FIXTURES, "pyth_xmr_account.json");
const colFile = path.join(FIXTURES, "pyth_col_account.json");
const rrFile = path.join(FIXTURES, "pyth_rr_account.json");

fs.writeFileSync(xmrFile, JSON.stringify(toAccountJson(xmrPubkey, xmrData, lamports), null, 2));
fs.writeFileSync(colFile, JSON.stringify(toAccountJson(colPubkey, colData, lamports), null, 2));
fs.writeFileSync(rrFile, JSON.stringify(toAccountJson(rrPubkey, rrData, lamports), null, 2));

console.log(`[gen-mock-pyth] publishTime: ${nowTs}`);
console.log(`[gen-mock-pyth] XMR oracle: ${xmrPubkey}`);
console.log(`[gen-mock-pyth] COL oracle: ${colPubkey}`);
console.log(`[gen-mock-pyth] RR oracle: ${rrPubkey}`);
console.log(`[gen-mock-pyth] COL oracle: ${colPubkey}`);
