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
const TOKEN_2022 = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

const GLOBAL_STATE_SEED = Buffer.from("global_state");
const WSXMR_MINT_SEED = Buffer.from("wsxmr_mint");
const PROGRAM_COLLATERAL_SEED = Buffer.from("program_collateral");
const VAULT_SEED = Buffer.from("vault");
const VAULT_COLLATERAL_SEED = Buffer.from("vault_collateral");
const PENDING_RETURNS_SEED = Buffer.from("pending_returns");
const MINT_REQUEST_SEED = Buffer.from("mint_request");
const BURN_REQUEST_SEED = Buffer.from("burn_request");
const SOL_ESCROW_SEED = Buffer.from("sol_escrow");
const AUCTION_SEED = Buffer.from("auction");
const AUCTION_BOND_SEED = Buffer.from("auction_bond");

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

module.exports = {
  DEVNET_URL, ROOT, KEY_DIR,
  PROGRAM_ID, TOKEN_2022,
  GLOBAL_STATE_SEED, WSXMR_MINT_SEED, PROGRAM_COLLATERAL_SEED,
  VAULT_SEED, VAULT_COLLATERAL_SEED, PENDING_RETURNS_SEED,
  MINT_REQUEST_SEED, BURN_REQUEST_SEED, SOL_ESCROW_SEED,
  AUCTION_SEED, AUCTION_BOND_SEED,
  findPda, conn, loadKeypair, saveKeypair, keypairOrNew, adminKeypair,
  makeProvider, loadProgram,
  confirm, sendAndConfirm, rpcIx,
};
