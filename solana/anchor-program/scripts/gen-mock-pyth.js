#!/usr/bin/env node
// gen-mock-pyth.js
// Generates mock Pyth PriceUpdateV2 account JSON files in tests/fixtures/ so
// solana-test-validator can pre-load them via Anchor.toml [[test.validator.account]].
//
// QQQx variant: collateral fixtures embed QQQX_USD_FEED_ID from constants.rs.
//
// Ownership model: the accounts are owned by the oracle-mock program
// (programs/oracle-mock), a test-only writer that lets the suite update
// price/ema/publish_time mid-test via its `write_account` instruction —
// publish_time staleness is enforced against the validator clock which cannot
// be warped, so live updates are the only robust way to stay "fresh".
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const FIXTURES = path.join(ROOT, "tests", "fixtures");
fs.mkdirSync(FIXTURES, { recursive: true });

const { Keypair } = require(path.join(ROOT, "node_modules", "@solana", "web3.js"));

// oracle-mock program id — owns every mock oracle account so tests can rewrite
// them with write_account. Read from the deploy keypair if present.
const ORACLE_MOCK_ID = (() => {
  try {
    const kp = JSON.parse(
      fs.readFileSync(path.join(ROOT, "target/deploy/oracle_mock-keypair.json"), "utf8")
    );
    return Keypair.fromSecretKey(Uint8Array.from(kp)).publicKey.toBase58();
  } catch {
    return "AWKqcPUtpsaPr19XpCq2ZD6Bk4HRGXnsYy9DUrZkLixY";
  }
})();

// Load a persisted keypair, or generate + persist a fresh one so fixture
// addresses stay stable (Anchor.toml references fixed addresses).
function loadOrGenKeypair(file) {
  const p = path.join(FIXTURES, file);
  if (fs.existsSync(p)) {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(p, "utf8"))));
  }
  const kp = Keypair.generate();
  fs.writeFileSync(p, JSON.stringify(Array.from(kp.secretKey)));
  return kp;
}

// Feed IDs from constants.rs
const XMR_FEED_ID = Buffer.from([
  0x46, 0xb8, 0xcc, 0x93, 0x47, 0xf0, 0x43, 0x91,
  0x76, 0x4a, 0x03, 0x61, 0xe0, 0xb1, 0x7c, 0x3b,
  0xa3, 0x94, 0xb0, 0x01, 0xe7, 0xc3, 0x04, 0xf7,
  0x65, 0x0f, 0x63, 0x76, 0xe3, 0x7c, 0x32, 0x1d,
]);
const QQQX_FEED_ID = Buffer.from([
  0x17, 0x8a, 0x6f, 0x73, 0xa5, 0xae, 0xde, 0x9d,
  0x0d, 0x68, 0x2e, 0x86, 0xb0, 0x04, 0x7c, 0x9f,
  0x33, 0x3e, 0xd0, 0xef, 0xe5, 0xc6, 0x53, 0x7c,
  0xa9, 0x37, 0x56, 0x52, 0x19, 0xc4, 0x05, 0x4d,
]);

// Pyth PriceUpdateV2 layout (200 bytes total, 134 min):
// [0..8]   disc = sha256("account:PriceUpdateV2")[0..8]
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
function buildPythAccount(feedId, priceRaw, emaRaw, exponent, publishTime, confOverride) {
  const buf = Buffer.alloc(200, 0);
  Buffer.from([0xc8, 0x8c, 0x29, 0x47, 0x6e, 0x23, 0x15, 0x1c]).copy(buf, 0);
  feedId.copy(buf, 42);
  buf.writeBigInt64LE(BigInt(priceRaw), 74);
  buf.writeBigUInt64LE(confOverride != null ? BigInt(confOverride) : BigInt(priceRaw) / 1000n, 82);
  buf.writeInt32LE(exponent, 90);
  buf.writeBigInt64LE(BigInt(publishTime), 94);
  buf.writeBigInt64LE(BigInt(publishTime) - 10n, 102);
  buf.writeBigInt64LE(BigInt(emaRaw), 110);
  buf.writeBigUInt64LE(BigInt(emaRaw) / 1000n, 118);
  return buf;
}

function toAccountJson(pubkey, data, lamports, owner) {
  return {
    pubkey,
    account: {
      lamports,
      data: [data.toString("base64"), "base64"],
      owner,
      executable: false,
      rentEpoch: 0,
      space: data.length,
    },
  };
}

const nowTs = Math.floor(Date.now() / 1000);
const lamports = 2_000_000_000;
const EXP = -8;

// Prices (raw, exp -8): XMR $15 keeps u64 normalization overflow-free; QQQx $600.
const fixtures = [
  {
    name: "pyth_xmr_account.json",
    keyFile: "pyth_xmr_keypair.json",
    data: buildPythAccount(XMR_FEED_ID, 1_500_000_000n, 1_500_000_000n, EXP, nowTs),
  },
  {
    name: "pyth_col_account.json",
    keyFile: "pyth_col_keypair.json",
    data: buildPythAccount(QQQX_FEED_ID, 60_000_000_000n, 60_000_000_000n, EXP, nowTs),
  },
];

for (const f of fixtures) {
  const kp = loadOrGenKeypair(f.keyFile);
  fs.writeFileSync(
    path.join(FIXTURES, f.name),
    JSON.stringify(toAccountJson(kp.publicKey.toBase58(), f.data, lamports, ORACLE_MOCK_ID), null, 2)
  );
  console.log(`[gen-mock-pyth] ${f.name}: ${kp.publicKey.toBase58()} (owner ${ORACLE_MOCK_ID})`);
}
console.log(`[gen-mock-pyth] publishTime=${nowTs}`);
