// devnet-lib.js — shared helpers for devnet deployment/setup/refresher.
"use strict";

const fs = require("fs");
const path = require("path");
const { Connection, Keypair, PublicKey } = require("@solana/web3.js");
const anchor = require("@coral-xyz/anchor");

const DEVNET_URL = process.env.DEVNET_URL || "https://api.devnet.solana.com";
const ROOT = path.join(__dirname, "..");
const KEY_DIR = path.join(ROOT, "devnet");

const PROGRAM_ID = new PublicKey("C9kVasKgQiUX1BCngBjorvMA8QaFyERHvdkYdwPyy3H1"); // wrapsynth_vault_manager
const ORACLE_MOCK_ID = new PublicKey("AWKqcPUtpsaPr19XpCq2ZD6Bk4HRGXnsYy9DUrZkLixY");
const TOKEN_2022 = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

const XMR_FEED_ID = Buffer.from([
  0x46, 0xb8, 0xcc, 0x93, 0x47, 0xf0, 0x43, 0x91, 0x76, 0x4a, 0x03, 0x61, 0xe0, 0xb1, 0x7c, 0x3b,
  0xa3, 0x94, 0xb0, 0x01, 0xe7, 0xc3, 0x04, 0xf7, 0x65, 0x0f, 0x63, 0x76, 0xe3, 0x7c, 0x32, 0x1d,
]);
// Pyth Crypto.SOL/USD feed ID — matches SOL_USD_FEED_ID in constants.rs
const SOL_FEED_ID = Buffer.from([
  0xef, 0x0d, 0x8b, 0x6f, 0xda, 0x2c, 0xeb, 0xa4, 0x1d, 0xa1, 0x5d, 0x40, 0x95, 0xd1, 0xda, 0x39,
  0x2a, 0x0d, 0x2f, 0x8e, 0xd0, 0xc6, 0xc7, 0xbc, 0x0f, 0x4c, 0xfa, 0xc8, 0xc2, 0x80, 0xb5, 0x6d,
]);

const GLOBAL_STATE_SEED = Buffer.from("global_state");
const WSXMR_MINT_SEED = Buffer.from("wsxmr_mint");
const PROGRAM_COLLATERAL_SEED = Buffer.from("program_collateral");
const VAULT_SEED = Buffer.from("vault");
const VAULT_COLLATERAL_SEED = Buffer.from("vault_collateral");
const PENDING_RETURNS_SEED = Buffer.from("pending_returns");
const MINT_REQUEST_SEED = Buffer.from("mint_request");
const BURN_REQUEST_SEED = Buffer.from("burn_request");
const SOL_ESCROW_SEED = Buffer.from("sol_escrow");

const findPda = (seeds, pid = PROGRAM_ID) => PublicKey.findProgramAddressSync(seeds, pid)[0];

const conn = new Connection(DEVNET_URL, "confirmed");
// Some RPC providers (Alchemy free tier) reject getProgramAccounts — re-route
// those calls to the public devnet RPC with retries when the primary isn't it.
if (!DEVNET_URL.includes("api.devnet.solana.com")) {
  const gpaConn = new Connection(
    process.env.GPA_URL || "https://api.devnet.solana.com",
    "confirmed"
  );
  const gpa = gpaConn.getProgramAccounts.bind(gpaConn);
  conn.getProgramAccounts = async (...args) => {
    let last;
    for (let i = 0; i < 12; i++) {
      try {
        return await gpa(...args);
      } catch (e) {
        last = e;
        await new Promise((r) => setTimeout(r, 4000));
      }
    }
    throw last;
  };
}

function loadKeypair(file) {
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(file, "utf8"))));
}
function saveKeypair(file, kp) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(Array.from(kp.secretKey)));
}
/** Load a keypair if it exists, otherwise generate + persist. */
function keypairOrNew(file) {
  const p = path.join(KEY_DIR, file);
  if (fs.existsSync(p)) return loadKeypair(p);
  const kp = Keypair.generate();
  saveKeypair(p, kp);
  return kp;
}

function adminKeypair() {
  return loadKeypair(process.env.ADMIN_KEY || `${process.env.HOME}/.config/solana/id.json`);
}

function makeProvider(payer) {
  return new anchor.AnchorProvider(conn, new anchor.Wallet(payer), { commitment: "confirmed" });
}

function loadProgram(payer) {
  const idl = JSON.parse(fs.readFileSync(path.join(ROOT, "target/idl/wrapsynth_vault_manager.json"), "utf8"));
  return new anchor.Program(idl, makeProvider(payer));
}
function loadOracleMock(payer) {
  const idl = JSON.parse(fs.readFileSync(path.join(ROOT, "target/idl/oracle_mock.json"), "utf8"));
  return new anchor.Program(idl, makeProvider(payer));
}

const EXP = -8;
/** 200-byte mock PriceUpdateV2 blob — same layout the on-chain parser reads. */
function pythBlob(feedId, priceRaw, emaRaw, publishTs, confRaw) {
  const b = Buffer.alloc(200, 0);
  Buffer.from([0xc8, 0x8c, 0x29, 0x47, 0x6e, 0x23, 0x15, 0x1c]).copy(b, 0);
  feedId.copy(b, 42);
  b.writeBigInt64LE(priceRaw, 74);
  b.writeBigUInt64LE(confRaw ?? priceRaw / 1000n, 82);
  b.writeInt32LE(EXP, 90);
  b.writeBigInt64LE(publishTs, 94);
  b.writeBigInt64LE(publishTs - 10n, 102);
  b.writeBigInt64LE(emaRaw, 110);
  b.writeBigUInt64LE(emaRaw / 1000n, 118);
  return b;
}

/** HTTP-poll confirmation — avoids ws subs that die under devnet 429s. */
async function confirm(sig, timeoutMs = 60_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const st = await conn.getSignatureStatuses([sig]);
    const v = st?.value?.[0];
    if (v?.err) throw new Error("tx failed: " + JSON.stringify(v.err));
    if (v?.confirmationStatus === "confirmed" || v?.confirmationStatus === "finalized") return;
    await new Promise((r) => setTimeout(r, 2500));
  }
  throw new Error("confirmation timeout: " + sig);
}

/** Send + confirm via HTTP polling (429-safe). */
async function sendAndConfirm(tx, signers) {
  const sig = await conn.sendTransaction(tx, signers);
  await confirm(sig);
  return sig;
}

/** Anchor .transaction() + HTTP send/confirm — no websocket path. Paced to
 * stay inside the public devnet RPC's per-IP rate budget. */
async function rpcIx(builder, signers, payer) {
  const tx = await builder.transaction();
  const sig = await sendAndConfirm(tx, [payer, ...signers]);
  await new Promise((r) => setTimeout(r, 2000));
  return sig;
}

async function writeOracle(oracleMock, payer, acct, feedId, usd, { emaUsd, publishTs } = {}) {
  const priceRaw = BigInt(usd) * 100_000_000n;
  const emaRaw = BigInt(emaUsd ?? usd) * 100_000_000n;
  const ts = publishTs ?? BigInt(Math.floor(Date.now() / 1000));
  const blob = pythBlob(feedId, priceRaw, emaRaw, ts);
  return rpcIx(
    oracleMock.methods
      .writeAccount(new anchor.BN(0), blob)
      .accounts({ target: acct, payer: payer.publicKey }),
    [payer], payer
  );
}

module.exports = {
  DEVNET_URL, ROOT, KEY_DIR,
  PROGRAM_ID, ORACLE_MOCK_ID, TOKEN_2022,
  XMR_FEED_ID, SOL_FEED_ID,
  GLOBAL_STATE_SEED, WSXMR_MINT_SEED, PROGRAM_COLLATERAL_SEED,
  VAULT_SEED, VAULT_COLLATERAL_SEED, PENDING_RETURNS_SEED,
  MINT_REQUEST_SEED, BURN_REQUEST_SEED, SOL_ESCROW_SEED,
  findPda, conn, loadKeypair, saveKeypair, keypairOrNew, adminKeypair,
  makeProvider, loadProgram, loadOracleMock, pythBlob, writeOracle,
  confirm, sendAndConfirm, rpcIx,
};
