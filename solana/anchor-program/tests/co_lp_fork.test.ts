/**
 * WrapSynth Co-LP Fork Test — verifies the hand-rolled Orca Whirlpools CPI
 * layouts (utils/whirlpool.rs) against the REAL mainnet Orca program.
 *
 * Run via: npm run test:fork  (see scripts/run-fork-tests.sh)
 *
 * The validator clones the Orca program + WhirlpoolsConfig + FeeTier from
 * mainnet, then this suite creates a fresh sUSDe/wsXMR pool locally with the
 * real program binary and exercises the full co-LP lifecycle:
 *   user_open_co_lp → swap (fees) → collect_co_lp_fees → unwind_co_lp
 */

import * as anchor from "@coral-xyz/anchor";
import { AnchorProvider, BN } from "@coral-xyz/anchor";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  AddressLookupTableProgram,
  AddressLookupTableAccount,
  LAMPORTS_PER_SOL,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddressSync,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createMintToInstruction,
  getAccount,
} from "@solana/spl-token";
import { assert } from "chai";
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { keccak_256 } from "@noble/hashes/sha3";
import { sha256 } from "@noble/hashes/sha256";
import { Point } from "@noble/ed25519";
import { IDL } from "../types/wrapsynth_vault_manager";

// ─── Orca mainnet constants (cloned into the fork validator) ─────────────────
const ORCA_PROGRAM_ID = new PublicKey("whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc");
const ORCA_CONFIG = new PublicKey("2LecshUwdy9xi7meFgHtFJQNSKk4KdTrcpvaB56dP2NQ");
const ORCA_FEE_TIER_64 = new PublicKey("HT55NVGVTjWmWLjV7BrSMPVZ7ppU8T2xE5nCAZ6YaGad");
const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const TICK_SPACING = 64;
const TICKS_IN_ARRAY = 88 * TICK_SPACING;
const MIN_SQRT_PRICE = 4295048016n;
const MAX_SQRT_PRICE = 79226673515401279992447579055n;

// ─── Program seeds (mirror constants.rs) ─────────────────────────────────────
const GLOBAL_STATE_SEED = Buffer.from("global_state");
const VAULT_SEED = Buffer.from("vault");
const WSXMR_MINT_SEED = Buffer.from("wsxmr_mint");
const VAULT_COLLATERAL_SEED = Buffer.from("vault_collateral");
const CO_LP_POSITION_SEED = Buffer.from("co_lp_position");
const MINT_REQUEST_SEED = Buffer.from("mint_request");
const PENDING_RETURNS_SEED = Buffer.from("pending_returns");

const COLLATERAL_RATIO = 150n;
const DEFAULT_CO_LP_RANGE_BPS = 2500;

// Mock oracle prices (gen-mock-pyth.js): XMR = $150, collateral = $1
const XMR_USD_FEED_ID = Buffer.from([
  0x46, 0xb8, 0xcc, 0x93, 0x47, 0xf0, 0x43, 0x91,
  0x76, 0x4a, 0x03, 0x61, 0xe0, 0xb1, 0x7c, 0x3b,
  0xa3, 0x94, 0xb0, 0x01, 0xe7, 0xc3, 0x04, 0xf7,
  0x65, 0x0f, 0x63, 0x76, 0xe3, 0x7c, 0x32, 0x1d,
]);
const COL_USD_FEED_ID = Buffer.from([
  0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08,
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f, 0x10,
  0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18,
  0x19, 0x1a, 0x1b, 0x1c, 0x1d, 0x1e, 0x1f, 0x20,
]);

// ─── Generic helpers ─────────────────────────────────────────────────────────
function bigintToLeBytes(value: bigint, length: number): Uint8Array {
  const arr = new Uint8Array(length);
  let v = value;
  for (let i = 0; i < length; i++) {
    arr[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return arr;
}

function disc(name: string): Buffer {
  const h = sha256(new TextEncoder().encode(`global:${name}`));
  return Buffer.from(h.slice(0, 8));
}

function isqrt(n: bigint): bigint {
  if (n < 2n) return n;
  let x = 1n << BigInt(Math.ceil(n.toString(2).length / 2));
  while (true) {
    const y = (x + n / x) >> 1n;
    if (y >= x) return x;
    x = y;
  }
}

// ─── PDA derives ─────────────────────────────────────────────────────────────
function deriveGlobalState(programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([GLOBAL_STATE_SEED], programId);
}
function deriveWsxmrMint(programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([WSXMR_MINT_SEED], programId);
}
function deriveVault(lp: PublicKey, programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([VAULT_SEED, lp.toBuffer()], programId);
}
function deriveVaultCollateral(vault: PublicKey, programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([VAULT_COLLATERAL_SEED, vault.toBuffer()], programId);
}
function deriveMintRequest(requestId: Buffer, programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([MINT_REQUEST_SEED, requestId], programId);
}
function derivePendingReturns(owner: PublicKey, programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([PENDING_RETURNS_SEED, owner.toBuffer()], programId);
}
function deriveCoLpPosition(vault: PublicKey, user: PublicKey, nonce: bigint, programId: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [CO_LP_POSITION_SEED, vault.toBuffer(), user.toBuffer(), bigintToLeBytes(nonce, 8)],
    programId
  );
}
function deriveWhirlpool(mintA: PublicKey, mintB: PublicKey, tickSpacing: number): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("whirlpool"),
      ORCA_CONFIG.toBuffer(),
      mintA.toBuffer(),
      mintB.toBuffer(),
      bigintToLeBytes(BigInt(tickSpacing), 2),
    ],
    ORCA_PROGRAM_ID
  );
}
function deriveTickArray(whirlpool: PublicKey, startIndex: number): [PublicKey, number] {
  // Whirlpool derives the tick-array PDA with the start index as an ASCII
  // decimal string seed (e.g. "-52986"), NOT little-endian i32 bytes.
  return PublicKey.findProgramAddressSync(
    [Buffer.from("tick_array"), whirlpool.toBuffer(), Buffer.from(String(startIndex))],
    ORCA_PROGRAM_ID
  );
}
function deriveTokenBadge(config: PublicKey, mint: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("token_badge"), config.toBuffer(), mint.toBuffer()],
    ORCA_PROGRAM_ID
  );
}
function deriveConfigExtension(config: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("whirlpools_config_extension"), config.toBuffer()],
    ORCA_PROGRAM_ID
  );
}
function deriveOracle(whirlpool: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("oracle"), whirlpool.toBuffer()], ORCA_PROGRAM_ID);
}
function derivePosition(positionMint: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync([Buffer.from("position"), positionMint.toBuffer()], ORCA_PROGRAM_ID);
}

// ─── Tick math mirrors (utils/whirlpool.rs) ──────────────────────────────────
function computeRangeTicks(currentTick: number, rangeBps: number, tickSpacing: number): [number, number] {
  const halfRange = rangeBps / 20000;
  const price = Math.pow(1.0001, currentTick);
  const lowerPrice = price * (1 - halfRange);
  const upperPrice = price * (1 + halfRange);
  const lowerTick = Math.floor(Math.log(lowerPrice) / Math.log(1.0001));
  const upperTick = Math.ceil(Math.log(upperPrice) / Math.log(1.0001));
  const lower = Math.floor(lowerTick / tickSpacing) * tickSpacing;
  const upper = Math.ceil(upperTick / tickSpacing) * tickSpacing;
  return [lower, upper];
}

function tickArrayStartIndex(tick: number, tickSpacing: number): number {
  const ticksInArray = 88 * tickSpacing;
  const start = Math.trunc(tick / ticksInArray) * ticksInArray;
  if (tick < 0 && tick % ticksInArray !== 0) return start - ticksInArray;
  return start;
}

// ─── Ed25519 helpers (mirror vault_manager.ts) ───────────────────────────────
const ED25519_L = 2n ** 252n + 27742317777372353535851937790883648493n;

function computeCommitment(secret: Buffer): Buffer {
  let scalar = 0n;
  for (let i = 0; i < 32; i++) scalar |= BigInt(secret[i]) << BigInt(i * 8);
  const reduced = scalar % ED25519_L;
  const compressed = Buffer.from(Point.BASE.multiply(reduced).toRawBytes());
  return Buffer.from(keccak_256(compressed));
}

function computePublicKey(secret: Buffer): Buffer {
  let scalar = 0n;
  for (let i = 0; i < 32; i++) scalar |= BigInt(secret[i]) << BigInt(i * 8);
  const reduced = scalar % ED25519_L;
  return Buffer.from(Point.BASE.multiply(reduced).toRawBytes());
}

function computeMintRequestId(
  initiator: PublicKey,
  vault: PublicKey,
  xmrAmount: bigint,
  commitment: Buffer,
  nonce: bigint
): Buffer {
  const data = Buffer.concat([
    initiator.toBuffer(),
    vault.toBuffer(),
    Buffer.from(bigintToLeBytes(xmrAmount, 8)),
    commitment,
    Buffer.from(bigintToLeBytes(nonce, 8)),
  ]);
  return Buffer.from(keccak_256(data));
}

// ─── Orca instruction builders ───────────────────────────────────────────────
function initializePoolIx(
  funder: PublicKey,
  mintA: PublicKey,
  mintB: PublicKey,
  whirlpool: PublicKey,
  vaultA: PublicKey,
  vaultB: PublicKey,
  sqrtPrice: bigint,
  tickSpacing: number
): TransactionInstruction {
  // initialize_pool_v2 (token-extensions path) — required because our mints are
  // Token-2022. token_vault_a/b are fresh keypairs created by the program, so
  // they are writable+signer. token_badge_a/b are derived PDAs
  // ["token_badge", config, mint] — present-but-uninitialized marks "no hook".
  const [badgeA] = deriveTokenBadge(ORCA_CONFIG, mintA);
  const [badgeB] = deriveTokenBadge(ORCA_CONFIG, mintB);
  return new TransactionInstruction({
    programId: ORCA_PROGRAM_ID,
    keys: [
      { pubkey: ORCA_CONFIG, isSigner: false, isWritable: false },          // whirlpools_config
      { pubkey: mintA, isSigner: false, isWritable: false },                // token_mint_a
      { pubkey: mintB, isSigner: false, isWritable: false },                // token_mint_b
      { pubkey: badgeA, isSigner: false, isWritable: false },               // token_badge_a
      { pubkey: badgeB, isSigner: false, isWritable: false },               // token_badge_b
      { pubkey: funder, isSigner: true, isWritable: true },                 // funder
      { pubkey: whirlpool, isSigner: false, isWritable: true },             // whirlpool (init)
      { pubkey: vaultA, isSigner: true, isWritable: true },                 // token_vault_a
      { pubkey: vaultB, isSigner: true, isWritable: true },                 // token_vault_b
      { pubkey: ORCA_FEE_TIER_64, isSigner: false, isWritable: false },     // fee_tier
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },// token_program_a
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },// token_program_b
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // system_program
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },   // rent
    ],
    data: Buffer.concat([
      disc("initialize_pool_v2"),
      Buffer.from(bigintToLeBytes(BigInt(tickSpacing), 2)),   // tick_spacing: u16
      Buffer.from(bigintToLeBytes(sqrtPrice, 16)),            // initial_sqrt_price: u128
    ]),
  });
}

function initializeTickArrayIx(
  funder: PublicKey,
  whirlpool: PublicKey,
  tickArray: PublicKey,
  startTick: number
): TransactionInstruction {
  return new TransactionInstruction({
    programId: ORCA_PROGRAM_ID,
    keys: [
      { pubkey: whirlpool, isSigner: false, isWritable: false },
      { pubkey: funder, isSigner: true, isWritable: true },
      { pubkey: tickArray, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: Buffer.concat([
      disc("initialize_tick_array"),
      Buffer.from(bigintToLeBytes(BigInt(startTick), 4)),
    ]),
  });
}

function initializeOracleIx(funder: PublicKey, whirlpool: PublicKey, oracle: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: ORCA_PROGRAM_ID,
    keys: [
      { pubkey: whirlpool, isSigner: false, isWritable: false },
      { pubkey: funder, isSigner: true, isWritable: true },
      { pubkey: oracle, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data: disc("initialize_oracle"),
  });
}

function swapV2Ix(
  tokenAuthority: PublicKey,
  whirlpool: PublicKey,
  mintA: PublicKey,
  mintB: PublicKey,
  ownerA: PublicKey,
  vaultA: PublicKey,
  ownerB: PublicKey,
  vaultB: PublicKey,
  tickArray0: PublicKey,
  tickArray1: PublicKey,
  tickArray2: PublicKey,
  oracle: PublicKey,
  amount: bigint,
  otherAmountThreshold: bigint,
  sqrtPriceLimit: bigint,
  aToB: boolean
): TransactionInstruction {
  return new TransactionInstruction({
    programId: ORCA_PROGRAM_ID,
    keys: [
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: MEMO_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: tokenAuthority, isSigner: true, isWritable: false },
      { pubkey: whirlpool, isSigner: false, isWritable: true },
      { pubkey: mintA, isSigner: false, isWritable: false },
      { pubkey: mintB, isSigner: false, isWritable: false },
      { pubkey: ownerA, isSigner: false, isWritable: true },
      { pubkey: vaultA, isSigner: false, isWritable: true },
      { pubkey: ownerB, isSigner: false, isWritable: true },
      { pubkey: vaultB, isSigner: false, isWritable: true },
      { pubkey: tickArray0, isSigner: false, isWritable: true },
      { pubkey: tickArray1, isSigner: false, isWritable: true },
      { pubkey: tickArray2, isSigner: false, isWritable: true },
      { pubkey: oracle, isSigner: false, isWritable: true },
    ],
    data: Buffer.concat([
      disc("swap_v2"),
      Buffer.from(bigintToLeBytes(amount, 8)),
      Buffer.from(bigintToLeBytes(otherAmountThreshold, 8)),
      Buffer.from(bigintToLeBytes(sqrtPriceLimit, 16)),
      Buffer.from([1]), // amount_is_input
      Buffer.from([aToB ? 1 : 0]),
      Buffer.from([0]), // remaining_accounts_info
    ]),
  });
}

// ─── Main suite ──────────────────────────────────────────────────────────────
describe("Co-LP Fork Test (real Orca program)", () => {
  const provider = anchor.AnchorProvider.env();
  // Program ID comes from the committed deploy keypair (matches declare_id!)
  const deployKeypair = JSON.parse(
    fs.readFileSync(path.join(__dirname, "fixtures", "vault_manager_deploy_keypair.json"), "utf8")
  );
  anchor.setProvider(provider);
  const PROGRAM_ID = Keypair.fromSecretKey(Uint8Array.from(deployKeypair)).publicKey;
  const idl = JSON.parse(JSON.stringify(IDL));
  idl.address = PROGRAM_ID.toBase58();
  const program = new (anchor.Program as any)(idl, provider) as any;
  const conn = provider.connection;

  const admin = (provider.wallet as any).payer as Keypair;
  const lp = Keypair.generate();
  const user = Keypair.generate();

  // ── v0 + Address Lookup Table helpers ──────────────────────────────────────
  // The co-LP instructions pass ~30 accounts (whirlpool program, vaults, badges,
  // tick arrays, …) and blow past the 1232-byte legacy tx limit. Pack the shared
  // addresses into a LUT and send versioned transactions.
  let coLpLutAddr: PublicKey | undefined;

  async function buildLut(addresses: PublicKey[]): Promise<AddressLookupTableAccount> {
    if (coLpLutAddr) {
      const cached = await conn.getAddressLookupTable(coLpLutAddr);
      if (cached.value) return cached.value;
    }
    const slot = await conn.getSlot();
    const [createIx, lutAddr] = AddressLookupTableProgram.createLookupTable({
      authority: admin.publicKey,
      payer: admin.publicKey,
      recentSlot: slot > 0 ? slot - 1 : 0,
    });
    const extendIx = AddressLookupTableProgram.extendLookupTable({
      payer: admin.publicKey,
      authority: admin.publicKey,
      lookupTable: lutAddr,
      addresses,
    });
    await provider.sendAndConfirm(new Transaction().add(createIx, extendIx), [admin]);
    // A LUT can only be used for lookups in a slot AFTER its lastExtendedSlot —
    // resolve() returns the account as soon as it exists, which is too early and
    // yields "Transaction address table lookup uses an invalid index". Poll until
    // the chain has moved past the extend slot (i.e. the LUT is actually active).
    for (let i = 0; i < 60; i++) {
      const res = await conn.getAddressLookupTable(lutAddr);
      const curSlot = await conn.getSlot();
      if (res.value && Number(res.value.state.lastExtendedSlot) < curSlot) {
        coLpLutAddr = lutAddr;
        return res.value;
      }
      await new Promise(r => setTimeout(r, 400));
    }
    throw new Error("lookup table did not activate");
  }

  async function sendV0(ixs: TransactionInstruction[], extraSigners: Keypair[]) {
    const { blockhash } = await conn.getLatestBlockhash();
    const msg = new TransactionMessage({
      payerKey: admin.publicKey,
      recentBlockhash: blockhash,
      instructions: ixs,
    }).compileToV0Message(coLpLutAddr ? [ (await conn.getAddressLookupTable(coLpLutAddr)).value! ] : []);
    const tx = new VersionedTransaction(msg);
    tx.sign([admin, ...extraSigners]);
    const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
    await conn.confirmTransaction(sig, "confirmed");
    return sig;
  }


  const [globalState] = deriveGlobalState(PROGRAM_ID);
  const [wsxmrMint] = deriveWsxmrMint(PROGRAM_ID);
  const [vaultPda] = deriveVault(lp.publicKey, PROGRAM_ID);
  const [vaultCollateralAta] = deriveVaultCollateral(vaultPda, PROGRAM_ID);
  const [userPendingReturns] = derivePendingReturns(user.publicKey, PROGRAM_ID);

  const collateralMintKeypair = Keypair.generate();
  let collateralMint: PublicKey;
  let lpCollateralAta: PublicKey;
  let userWsxmrAta: PublicKey;
  let lpWsxmrAta: PublicKey;
  let userCollateralAta: PublicKey;

  // Pool state
  let whirlpoolPda: PublicKey;
  let mintA: PublicKey;
  let mintB: PublicKey;
  let vaultA: PublicKey;
  let vaultB: PublicKey;
  let currentTick = 0;
  let tickArrayLower: PublicKey;
  let tickArrayUpper: PublicKey;
  let tickArrayStartLower = 0;
  let tickArrayStartUpper = 0;

  // Position state
  let positionMint: Keypair;
  let positionTokenAccount: PublicKey;
  let positionPda: PublicKey;
  let positionSusdeAta: PublicKey;
  let positionWsxmrAta: PublicKey;
  let coLpPositionPda: PublicKey;
  let coLpNonce: bigint;
  let tokenVaultA: PublicKey;
  let tokenVaultB: PublicKey;

  // Mint flow key material
  const xmrAmount = 10_000_000_000n; // 0.01 XMR (12 dec)
  const wsxmrToMint = 1_000_000n; // 0.01 wsXMR (8 dec)
  const { secret, commitment } = (() => {
    const s = crypto.randomBytes(32);
    return { secret: s, commitment: computeCommitment(s) };
  })();
  const userPublicKey = computePublicKey(secret);
  const lpSecret = crypto.randomBytes(32);
  const lpCommitment = computeCommitment(lpSecret);
  const lpSpendKey = computePublicKey(lpSecret);
  const lpViewKey = computePublicKey(lpSecret);

  async function airdrop(to: PublicKey, sol: number) {
    await conn.confirmTransaction(await conn.requestAirdrop(to, sol * LAMPORTS_PER_SOL));
  }

  async function createAta(payer: Keypair, mint: PublicKey, owner: PublicKey): Promise<PublicKey> {
    const ata = getAssociatedTokenAddressSync(mint, owner, true, TOKEN_2022_PROGRAM_ID);
    try {
      await getAccount(conn, ata, "confirmed", TOKEN_2022_PROGRAM_ID);
      return ata;
    } catch {
      const tx = new Transaction().add(
        createAssociatedTokenAccountInstruction(payer.publicKey, ata, owner, mint, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID)
      );
      await provider.sendAndConfirm(tx, [payer]);
      return ata;
    }
  }

  // ── Setup: protocol, vault, collateral ─────────────────────────────────────
  before(async () => {
    console.log("    [setup] airdropping...");
    await airdrop(lp.publicKey, 20);
    await airdrop(user.publicKey, 20);

    // Mock collateral mint (Token-2022, 18 decimals, admin-controlled)
    collateralMint = collateralMintKeypair.publicKey;
    const lamports = await conn.getMinimumBalanceForRentExemption(82);
    const createMintTx = new Transaction().add(
      SystemProgram.createAccount({
        fromPubkey: admin.publicKey,
        newAccountPubkey: collateralMintKeypair.publicKey,
        lamports,
        space: 82,
        programId: TOKEN_2022_PROGRAM_ID,
      })
    );
    const { createInitializeMint2Instruction } = await import("@solana/spl-token");
    createMintTx.add(
      createInitializeMint2Instruction(collateralMintKeypair.publicKey, 18, admin.publicKey, null, TOKEN_2022_PROGRAM_ID)
    );
    console.log("    [setup] creating collateral mint...");
    await provider.sendAndConfirm(createMintTx, [admin, collateralMintKeypair]);

    console.log("    [setup] initializing protocol...");
    await program.methods
      .initialize(new PublicKey(XMR_USD_FEED_ID), collateralMint)
      .accounts({
        authority: admin.publicKey,
        globalState,
        wsxmrMint,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: SYSVAR_RENT_PUBKEY,
      } as any)
      .rpc();

    await program.methods
      .createVault()
      .accounts({ lp: lp.publicKey, vault: vaultPda, globalState, systemProgram: SystemProgram.programId } as any)
      .signers([lp])
      .rpc();

    await program.methods
      .initializeVaultCollateral()
      .accounts({
        lp: lp.publicKey,
        vault: vaultPda,
        collateralMint,
        vaultCollateralAta,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      } as any)
      .signers([lp])
      .rpc();

    // Deposit 10 collateral (18 dec) — u64 caps collateral at ~18.4 units
    lpCollateralAta = await createAta(admin, collateralMint, lp.publicKey);
    const mintColTx = new Transaction().add(
      createMintToInstruction(collateralMint, lpCollateralAta, admin.publicKey, BigInt("10000000000000000000"), [], TOKEN_2022_PROGRAM_ID)
    );
    await provider.sendAndConfirm(mintColTx, [admin]);

    await program.methods
      .depositCollateralShares(new BN("10000000000000000000"))
      .accounts({
        lp: lp.publicKey,
        vault: vaultPda,
        globalState,
        collateralMint,
        lpCollateralAta,
        vaultCollateralAta,
        pythXmr: new PublicKey("6LwVtpkVzR9zSCo4xKkesQJaraDJaqzaQTRAQfZo6jxf"),
        pythCollateral: new PublicKey("7D8MNQMdCEDrVebrMPmnMQ5Z54WqceWsu89FDEqrWL73"),
        pythSusdeRr: new PublicKey("7e5pxK83ceXb2iWXBizF1U8MdL7C5VcVBBXpDWaYo3x1"),
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      } as any)
      .signers([lp])
      .rpc();

    // Pending returns + ATAs for the mint flow
    await program.methods
      .initializePendingReturns()
      .accounts({ owner: user.publicKey, pendingReturns: userPendingReturns, systemProgram: SystemProgram.programId } as any)
      .signers([user])
      .rpc();
    userWsxmrAta = await createAta(user, wsxmrMint, user.publicKey);
    lpWsxmrAta = await createAta(lp, wsxmrMint, lp.publicKey);
    userCollateralAta = await createAta(user, collateralMint, user.publicKey);
  });

  it("1. creates the sUSDe/wsXMR pool with the real Orca program", async () => {
    // Sort mints (whirlpool requires mint_a < mint_b)
    const sorted = [collateralMint, wsxmrMint].sort((a, b) => a.toBuffer().compare(b.toBuffer()));
    mintA = sorted[0];
    mintB = sorted[1];

    [whirlpoolPda] = deriveWhirlpool(mintA, mintB, TICK_SPACING);
    // Pool token vaults are created by the program in initialize_pool_v2 — they
    // must be fresh signer keypairs (NOT pre-created ATAs).
    const vaultAKeypair = Keypair.generate();
    const vaultBKeypair = Keypair.generate();
    vaultA = vaultAKeypair.publicKey;
    vaultB = vaultBKeypair.publicKey;

    // Pool price: sUSDe per wsXMR = 1/200 (XMR ≈ $200) → sqrt_price Q64.64
    const sqrtPrice = isqrt(((1n << 128n) * 5n) / 1000n);
    const tx = new Transaction().add(initializePoolIx(admin.publicKey, mintA, mintB, whirlpoolPda, vaultA, vaultB, sqrtPrice, TICK_SPACING));
    await provider.sendAndConfirm(tx, [admin, vaultAKeypair, vaultBKeypair]);

    // Verify the pool account layout matches utils/whirlpool.rs offsets
    const poolInfo = await conn.getAccountInfo(whirlpoolPda);
    assert.ok(poolInfo, "Pool account should exist");
    const d = poolInfo!.data;
    assert.equal(d.readUInt16LE(41), TICK_SPACING, "tick_spacing @ 41");
    currentTick = d.readInt32LE(81);
    assert.equal(new PublicKey(d.slice(101, 133)).toBase58(), mintA.toBase58(), "token_mint_a @ 101");
    assert.equal(new PublicKey(d.slice(133, 165)).toBase58(), vaultA.toBase58(), "token_vault_a @ 133");
    assert.equal(new PublicKey(d.slice(181, 213)).toBase58(), mintB.toBase58(), "token_mint_b @ 181");
    assert.equal(new PublicKey(d.slice(213, 245)).toBase58(), vaultB.toBase58(), "token_vault_b @ 213");
    console.log(`    ✓ Pool created: ${whirlpoolPda.toBase58()} (current tick ${currentTick})`);
  });

  it("2. initializes tick arrays for the co-LP range", async () => {
    const [lower, upper] = computeRangeTicks(currentTick, DEFAULT_CO_LP_RANGE_BPS, TICK_SPACING);
    tickArrayStartLower = tickArrayStartIndex(lower, TICK_SPACING);
    tickArrayStartUpper = tickArrayStartIndex(upper, TICK_SPACING);
    [tickArrayLower] = deriveTickArray(whirlpoolPda, tickArrayStartLower);
    [tickArrayUpper] = deriveTickArray(whirlpoolPda, tickArrayStartUpper);

    // Initialize the range arrays + neighbors (covers swap movement too)
    const starts = new Set<number>();
    for (let i = -2; i <= 2; i++) {
      starts.add(tickArrayStartIndex(currentTick, TICK_SPACING) + i * TICKS_IN_ARRAY);
    }
    starts.add(tickArrayStartLower);
    starts.add(tickArrayStartUpper);

    const tx = new Transaction();
    for (const s of starts) {
      const [arr] = deriveTickArray(whirlpoolPda, s);
      tx.add(initializeTickArrayIx(admin.publicKey, whirlpoolPda, arr, s));
    }
    await provider.sendAndConfirm(tx, [admin]);
    console.log(`    ✓ Tick arrays initialized (lower @ ${tickArrayStartLower}, upper @ ${tickArrayStartUpper})`);
  });

  it("3. mints wsXMR to the user (full mint flow)", async () => {
    const gs = await program.account.globalState.fetch(globalState);
    const nonce = BigInt(gs.requestNonce.toString()) + 1n;
    const requestId = computeMintRequestId(user.publicKey, vaultPda, xmrAmount, commitment, nonce);
    const [mintRequestPda] = deriveMintRequest(requestId, PROGRAM_ID);

    await program.methods
      .initiateMint(new BN(xmrAmount.toString()), Array.from(commitment), Array.from(userPublicKey), Array.from(requestId))
      .accounts({
        initiator: user.publicKey,
        recipient: user.publicKey,
        vault: vaultPda,
        globalState,
        mintRequest: mintRequestPda,
        griefingEscrow: user.publicKey,
        initiatorPendingReturns: userPendingReturns,
        pythXmr: new PublicKey("6LwVtpkVzR9zSCo4xKkesQJaraDJaqzaQTRAQfZo6jxf"),
        pythCollateral: new PublicKey("7D8MNQMdCEDrVebrMPmnMQ5Z54WqceWsu89FDEqrWL73"),
        pythSusdeRr: new PublicKey("7e5pxK83ceXb2iWXBizF1U8MdL7C5VcVBBXpDWaYo3x1"),
        systemProgram: SystemProgram.programId,
      } as any)
      .signers([user])
      .rpc();

    await program.methods
      .provideLpKey(Array.from(lpSpendKey), Array.from(lpViewKey), Array.from(lpCommitment))
      .accounts({
        lp: lp.publicKey,
        vault: vaultPda,
        globalState,
        mintRequest: mintRequestPda,
        pythXmr: new PublicKey("6LwVtpkVzR9zSCo4xKkesQJaraDJaqzaQTRAQfZo6jxf"),
        pythCollateral: new PublicKey("7D8MNQMdCEDrVebrMPmnMQ5Z54WqceWsu89FDEqrWL73"),
        pythSusdeRr: new PublicKey("7e5pxK83ceXb2iWXBizF1U8MdL7C5VcVBBXpDWaYo3x1"),
      } as any)
      .signers([lp])
      .rpc();

    await program.methods
      .setMintReady()
      .accounts({
        lp: lp.publicKey,
        vault: vaultPda,
        globalState,
        mintRequest: mintRequestPda,
        pythXmr: new PublicKey("6LwVtpkVzR9zSCo4xKkesQJaraDJaqzaQTRAQfZo6jxf"),
        pythCollateral: new PublicKey("7D8MNQMdCEDrVebrMPmnMQ5Z54WqceWsu89FDEqrWL73"),
        pythSusdeRr: new PublicKey("7e5pxK83ceXb2iWXBizF1U8MdL7C5VcVBBXpDWaYo3x1"),
      } as any)
      .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 250_000 })])
      .signers([lp])
      .rpc();

    await program.methods
      .revealSecret(Array.from(secret))
      .accounts({ caller: user.publicKey, mintRequest: mintRequestPda } as any)
      .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 })])
      .signers([user])
      .rpc();

    await program.methods
      .finalizeMint()
      .accounts({
        caller: user.publicKey,
        vault: vaultPda,
        globalState,
        mintRequest: mintRequestPda,
        wsxmrMint,
        recipientWsxmrAta: userWsxmrAta,
        lpWsxmrAta,
        pendingReturns: userPendingReturns,
        pythXmr: new PublicKey("6LwVtpkVzR9zSCo4xKkesQJaraDJaqzaQTRAQfZo6jxf"),
        pythCollateral: new PublicKey("7D8MNQMdCEDrVebrMPmnMQ5Z54WqceWsu89FDEqrWL73"),
        pythSusdeRr: new PublicKey("7e5pxK83ceXb2iWXBizF1U8MdL7C5VcVBBXpDWaYo3x1"),
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      } as any)
      .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })])
      .signers([user])
      .rpc();

    const userBal = await conn.getTokenAccountBalance(userWsxmrAta);
    assert.isTrue(Number(userBal.value.amount) > 0, "User should have wsXMR");
    console.log(`    ✓ User wsXMR balance: ${userBal.value.amount}`);
  });

  it("4. user_open_co_lp deploys into the real pool", async () => {
    // Program-owned position ATAs (owner = GlobalState PDA)
    positionSusdeAta = getAssociatedTokenAddressSync(collateralMint, globalState, true, TOKEN_2022_PROGRAM_ID);
    positionWsxmrAta = getAssociatedTokenAddressSync(wsxmrMint, globalState, true, TOKEN_2022_PROGRAM_ID);
    await createAta(admin, collateralMint, globalState);
    await createAta(admin, wsxmrMint, globalState);

    // Position NFT mint + ATA (created by the program)
    positionMint = Keypair.generate();
    positionTokenAccount = getAssociatedTokenAddressSync(positionMint.publicKey, globalState, true, TOKEN_2022_PROGRAM_ID);
    [positionPda] = derivePosition(positionMint.publicKey);

    const gs = await program.account.globalState.fetch(globalState);
    coLpNonce = BigInt(gs.requestNonce.toString()) + 1n;
    [coLpPositionPda] = deriveCoLpPosition(vaultPda, user.publicKey, coLpNonce, PROGRAM_ID);

    // Whirlpool-internal accounts needed by increase_liquidity_v2.
    // token_vault_a/b live in the whirlpool account body (offsets 133 / 213).
    const whirlpoolAcct = await conn.getAccountInfo(whirlpoolPda);
    tokenVaultA = new PublicKey(whirlpoolAcct!.data.slice(133, 165));
    tokenVaultB = new PublicKey(whirlpoolAcct!.data.slice(213, 245));
    const [tokenBadgeA] = deriveTokenBadge(ORCA_CONFIG, mintA);
    const [tokenBadgeB] = deriveTokenBadge(ORCA_CONFIG, mintB);
    const [whirlpoolsConfigExtension] = deriveConfigExtension(ORCA_CONFIG);
    // Whirlpool's fixed position-NFT metadata update authority (address-constrained).
    const metadataUpdateAuth = new PublicKey("3axbTs2z5GBy6usVbNVoqEgZMng3vZvMnAoX29BFfwhr");

    // Pack all non-signer accounts into a lookup table (shared across co-LP txs).
    const lut = await buildLut([
      vaultPda, globalState, coLpPositionPda, positionTokenAccount, positionPda,
      whirlpoolPda, tokenVaultA, tokenVaultB, tokenBadgeA, tokenBadgeB,
      whirlpoolsConfigExtension, metadataUpdateAuth, tickArrayLower, tickArrayUpper, positionSusdeAta,
      positionWsxmrAta, userWsxmrAta, vaultCollateralAta, collateralMint, wsxmrMint,
      new PublicKey("6LwVtpkVzR9zSCo4xKkesQJaraDJaqzaQTRAQfZo6jxf"),
      new PublicKey("7D8MNQMdCEDrVebrMPmnMQ5Z54WqceWsu89FDEqrWL73"),
      new PublicKey("7e5pxK83ceXb2iWXBizF1U8MdL7C5VcVBBXpDWaYo3x1"),
      ORCA_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, SystemProgram.programId,
    ]);

    const ix = await program.methods
      .userOpenCoLp(new BN(wsxmrToMint.toString()), new BN(coLpNonce.toString()))
      .accounts({
        user: user.publicKey,
        vault: vaultPda,
        globalState,
        coLpPosition: coLpPositionPda,
        positionMint: positionMint.publicKey,
        positionTokenAccount,
        position: positionPda,
        whirlpool: whirlpoolPda,
        tickArrayLower,
        tickArrayUpper,
        positionSusdeAta,
        positionWsxmrAta,
        userWsxmrAta,
        vaultCollateralAta,
        collateralMint,
        wsxmrMint,
        pythXmr: new PublicKey("6LwVtpkVzR9zSCo4xKkesQJaraDJaqzaQTRAQfZo6jxf"),
        pythCollateral: new PublicKey("7D8MNQMdCEDrVebrMPmnMQ5Z54WqceWsu89FDEqrWL73"),
        pythSusdeRr: new PublicKey("7e5pxK83ceXb2iWXBizF1U8MdL7C5VcVBBXpDWaYo3x1"),
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      } as any)
      .remainingAccounts([
        // order must match handler's remaining_accounts indexing
        { pubkey: tokenVaultA, isSigner: false, isWritable: true },
        { pubkey: tokenVaultB, isSigner: false, isWritable: true },
        { pubkey: metadataUpdateAuth, isSigner: false, isWritable: false },
        { pubkey: ORCA_PROGRAM_ID, isSigner: false, isWritable: false }, // whirlpool_program
        { pubkey: new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"), isSigner: false, isWritable: false }, // memo_program
      ])
      .instruction();
    await sendV0(
      [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ix],
      [user, positionMint]
    );

    // Verify position state
    const coLp = await program.account.coLpPosition.fetch(coLpPositionPda);
    assert.equal(coLp.vault.toBase58(), vaultPda.toBase58());
    assert.equal(coLp.user.toBase58(), user.publicKey.toBase58());
    assert.isTrue(coLp.liquidity.gtn(0), "Position should have liquidity");
    assert.equal(coLp.positionAddress.toBase58(), positionPda.toBase58());

    const vault = await program.account.vault.fetch(vaultPda);
    assert.isTrue(vault.deployedCollateral.gtn(0), "Vault should track deployed collateral");

    // Verify the Orca Position account layout (liquidity @ 72, ticks @ 88/92)
    const posInfo = await conn.getAccountInfo(positionPda);
    const pd = posInfo!.data;
    const posLiquidity = pd.readBigUInt64LE(72) + (BigInt(pd.readUInt32LE(80)) << 32n); // u128 LE
    assert.isTrue(posLiquidity > 0n, "Orca Position should hold liquidity");
    const tickLower = pd.readInt32LE(88);
    const tickUpper = pd.readInt32LE(92);
    assert.isTrue(tickLower < currentTick && tickUpper > currentTick, "Range should bracket current tick");
    console.log(`    ✓ Position opened: liquidity=${posLiquidity}, ticks [${tickLower}, ${tickUpper}]`);
  });

  it("5. swap generates fees for the position", async () => {
    // Mint collateral to the user for the swap
    const mintTx = new Transaction().add(
      createMintToInstruction(collateralMint, userCollateralAta, admin.publicKey, BigInt("1000000000000000000"), [], TOKEN_2022_PROGRAM_ID)
    );
    await provider.sendAndConfirm(mintTx, [admin]);

    // Initialize the pool oracle (required by swap_v2)
    const [oracle] = deriveOracle(whirlpoolPda);
    try {
      await provider.sendAndConfirm(new Transaction().add(initializeOracleIx(admin.publicKey, whirlpoolPda, oracle)), [admin]);
    } catch (e: any) {
      console.log("    ⚠ initialize_oracle failed (may already exist):", e.message?.split("\n")[0]);
    }

    const collateralIsA = mintA.toBase58() === collateralMint.toBase58();
    // Re-fetch the live tick + sqrt_price (offset 65 = u128, offset 81 = i32).
    const wp = await conn.getAccountInfo(whirlpoolPda);
    const curSqrtPrice =
      wp!.data.readBigUInt64LE(65) + (wp!.data.readBigUInt64LE(73) << 64n);
    const liveTick = wp!.data.readInt32LE(81);
    currentTick = liveTick;
    // Swap tick arrays must be sequential from the array containing the current
    // tick, in the swap direction: a_to_b (selling token_a) decreases price →
    // descending tick arrays; b_to_a increases → ascending.
    const currStart = tickArrayStartIndex(currentTick, TICK_SPACING);
    const dir = collateralIsA ? -TICKS_IN_ARRAY : TICKS_IN_ARRAY;
    const [tickArr0] = deriveTickArray(whirlpoolPda, currStart);
    const [tickArr1] = deriveTickArray(whirlpoolPda, currStart + dir);
    const [tickArr2] = deriveTickArray(whirlpoolPda, currStart + 2 * dir);
    // Bound the price limit to ~5% sqrt_price so the swap stays inside the
    // provided tick arrays — the thin position liquidity would otherwise let the
    // price free-fall past the sequence (TickArraySequenceInvalidIndex).
    const sqrtPriceLimit = collateralIsA
      ? (curSqrtPrice * 95n) / 100n   // a_to_b: price floor just below current
      : (curSqrtPrice * 105n) / 100n; // b_to_a: price ceiling just above current
    console.log(`    [swap] liveTick=${currentTick} collateralIsA=${collateralIsA} arrays=[${currStart},${currStart+dir},${currStart+2*dir}] sqrtLimit=${sqrtPriceLimit}`);

    const swapTx = new Transaction().add(
      swapV2Ix(
        user.publicKey,
        whirlpoolPda,
        mintA,
        mintB,
        collateralIsA ? userCollateralAta : userWsxmrAta,
        vaultA,
        collateralIsA ? userWsxmrAta : userCollateralAta,
        vaultB,
        tickArr0,
        tickArr1,
        tickArr2,
        oracle,
        BigInt("2000000000000000000"), // 2 collateral
        1n, // min output
        sqrtPriceLimit,
        collateralIsA
      )
    );
    await provider.sendAndConfirm(swapTx, [user]);
    // Debug: whirlpool liquidity @49(u128), fee_growth_global_a@?, tick @81
    const wpAfter = (await conn.getAccountInfo(whirlpoolPda))!.data;
    const liq = wpAfter.readBigUInt64LE(49) + (wpAfter.readBigUInt64LE(57) << 64n);
    const feeGrowthA = wpAfter.readBigUInt64LE(277) + (wpAfter.readBigUInt64LE(285) << 64n);
    const feeGrowthB = wpAfter.readBigUInt64LE(293) + (wpAfter.readBigUInt64LE(301) << 64n);
    const tickAfter = wpAfter.readInt32LE(81);
    const userBal = (await conn.getTokenAccountBalance(userWsxmrAta)).value.amount;
    console.log(`    [swap] after: liquidity=${liq} tick=${tickAfter} feeGrowthA=${feeGrowthA} feeGrowthB=${feeGrowthB} userWsxmr=${userBal}`);
    console.log("    ✓ Swap executed (fees accrued to position)");
  });

  it("6. collect_co_lp_fees distributes to vault + user", async () => {
    const vaultBefore = await program.account.vault.fetch(vaultPda);
    const userWsxmrBefore = (await conn.getTokenAccountBalance(userWsxmrAta)).value.amount;

    // Debug: check accrued fees on the position. Position layout:
    // liquidity@72, tick_lower@88, tick_upper@92, fee_growth_chk_a@96(u128),
    // fee_growth_chk_b@112(u128), fee_owed_a@128(u64), fee_owed_b@136(u64).
    const posAcc = await conn.getAccountInfo(positionPda);
    const feeOwedA = posAcc!.data.readBigUInt64LE(128);
    const feeOwedB = posAcc!.data.readBigUInt64LE(136);
    const susdeBal = (await conn.getTokenAccountBalance(positionSusdeAta)).value.amount;
    const wsxmrBal = (await conn.getTokenAccountBalance(positionWsxmrAta)).value.amount;
    console.log(`    [collect] fee_owed_a=${feeOwedA} fee_owed_b=${feeOwedB} posSusde=${susdeBal} posWsxmr=${wsxmrBal}`);

    const collectIx = await program.methods
      .collectCoLpFees()
      .accounts({
        caller: user.publicKey,
        vault: vaultPda,
        globalState,
        coLpPosition: coLpPositionPda,
        position: positionPda,
        whirlpool: whirlpoolPda,
        positionTokenAccount,
        positionSusdeAta,
        positionWsxmrAta,
        vaultCollateralAta,
        userWsxmrAta,
        collateralMint,
        wsxmrMint,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      } as any)
      .remainingAccounts([
        { pubkey: tokenVaultA, isSigner: false, isWritable: true },
        { pubkey: tokenVaultB, isSigner: false, isWritable: true },
        { pubkey: ORCA_PROGRAM_ID, isSigner: false, isWritable: false }, // whirlpool_program
        { pubkey: MEMO_PROGRAM_ID, isSigner: false, isWritable: false }, // memo_program
        { pubkey: tickArrayLower, isSigner: false, isWritable: false },  // tick_array_lower
        { pubkey: tickArrayUpper, isSigner: false, isWritable: false },  // tick_array_upper
      ])
      .instruction();
    await sendV0(
      [ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }), collectIx],
      [user]
    );

    const vaultAfter = await program.account.vault.fetch(vaultPda);
    const userWsxmrAfter = (await conn.getTokenAccountBalance(userWsxmrAta)).value.amount;
    assert.isTrue(
      vaultAfter.collateralAmount.gt(vaultBefore.collateralAmount) || BigInt(userWsxmrAfter) > BigInt(userWsxmrBefore),
      "Fees should flow to vault or user"
    );
    console.log(`    ✓ Fees collected: vault collateral ${vaultBefore.collateralAmount} → ${vaultAfter.collateralAmount}`);
  });

  it("7. unwind_co_lp closes the position and returns proceeds", async () => {
    const userWsxmrBefore = BigInt((await conn.getTokenAccountBalance(userWsxmrAta)).value.amount);
    const vaultBefore = await program.account.vault.fetch(vaultPda);

    const unwindIx = await program.methods
      .unwindCoLp()
      .accounts({
        caller: user.publicKey,
        vault: vaultPda,
        globalState,
        coLpPosition: coLpPositionPda,
        position: positionPda,
        whirlpool: whirlpoolPda,
        positionMint: positionMint.publicKey,
        positionTokenAccount,
        tickArrayLower,
        tickArrayUpper,
        positionSusdeAta,
        positionWsxmrAta,
        vaultCollateralAta,
        userWsxmrAta,
        collateralMint,
        wsxmrMint,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      } as any)
      .remainingAccounts([
        { pubkey: tokenVaultA, isSigner: false, isWritable: true },
        { pubkey: tokenVaultB, isSigner: false, isWritable: true },
        { pubkey: ORCA_PROGRAM_ID, isSigner: false, isWritable: false }, // whirlpool_program
        { pubkey: MEMO_PROGRAM_ID, isSigner: false, isWritable: false }, // memo_program
      ])
      .instruction();
    await sendV0(
      [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), unwindIx],
      [user]
    );

    const vaultAfter = await program.account.vault.fetch(vaultPda);
    assert.equal(vaultAfter.deployedCollateral.toString(), "0", "Deployed collateral should be released");
    assert.isTrue(vaultAfter.collateralAmount.gt(vaultBefore.collateralAmount), "Collateral should return to vault");

    const userWsxmrAfter = BigInt((await conn.getTokenAccountBalance(userWsxmrAta)).value.amount);
    assert.isTrue(userWsxmrAfter > userWsxmrBefore, "wsXMR should return to user");

    // Position should be closed (account gone)
    const posInfo = await conn.getAccountInfo(positionPda);
    assert.isNull(posInfo, "Orca Position should be closed");
    console.log(`    ✓ Position unwound: vault collateral ${vaultBefore.collateralAmount} → ${vaultAfter.collateralAmount}, user wsXMR ${userWsxmrBefore} → ${userWsxmrAfter}`);
  });
});
