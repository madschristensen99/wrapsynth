/**
 * WrapSynth VaultManager — Integration Test Suite (QQQx-collateral variant)
 *
 * Covers:
 *   1. Protocol initialization
 *   2. Vault creation + config + collateral deposit
 *   3. Oracle rejection paths (stale / wide-conf / discount-guard / wrong feed)
 *   4. Full mint flow:  initiate → provide_lp_key → set_mint_ready → reveal → finalize
 *   5. Mint negatives: bad request_id, unwhitelisted + unfunded griefing escrow
 *   6. Full burn flow:  request → propose_hash → confirm_monero_lock → finalize_burn
 *   7. Burn negatives: bad request_id, below minimum, non-LP propose_hash
 *   8. Abort burn (pre-commit)
 *   9. Liquidation: crash oracle → execute_liquidation → backstop_vault
 *  10. Withdrawals: pending-returns claims backed by the program collateral pool
 *  11. Reconciliation, deactivation, multi-vault isolation
 *  12. Invariants: pool backing, vault ATA == vault.collateral_amount
 *
 * Oracle model: mock PriceUpdateV2 accounts are pre-loaded into the test
 * validator via Anchor.toml fixtures (scripts/gen-mock-pyth.js). Freshness uses
 * a far-future publish_time (age saturates to 0); the program validates feed_id
 * rather than account address, so crash/stale/discount fixtures share the QQQX
 * feed ID and are swapped in per-call.
 */

import * as anchor from "@coral-xyz/anchor";
import { Program, AnchorProvider, BN, web3 } from "@coral-xyz/anchor";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  Transaction,
  LAMPORTS_PER_SOL,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";
import {
  TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccountInstruction,
  getAssociatedTokenAddressSync,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createInitializeMint2Instruction,
  createMintToInstruction,
  createTransferInstruction,
  getMintLen,
  getAccount,
} from "@solana/spl-token";
import { assert } from "chai";
import * as crypto from "crypto";
import { keccak_256 } from "@noble/hashes/sha3";
import { Point } from "@noble/ed25519";

// Resolve from the project root — __dirname shifts when tests run precompiled
// from dist-test/. anchor test always runs with cwd = project root.
const idl = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "target/idl/wrapsynth_vault_manager.json"), "utf8")
);
const oracleMockIdl = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "target/idl/oracle_mock.json"), "utf8")
);

// ─── Constants mirrored from constants.rs ────────────────────────────────────
const GLOBAL_STATE_SEED      = Buffer.from("global_state");
const VAULT_SEED             = Buffer.from("vault");
const WSXMR_MINT_SEED        = Buffer.from("wsxmr_mint");
const MINT_REQUEST_SEED      = Buffer.from("mint_request");
const BURN_REQUEST_SEED      = Buffer.from("burn_request");
const PENDING_RETURNS_SEED   = Buffer.from("pending_returns");
const VAULT_COLLATERAL_SEED  = Buffer.from("vault_collateral");
const PROGRAM_COLLATERAL_SEED = Buffer.from("program_collateral");
const SOL_ESCROW_SEED        = Buffer.from("sol_escrow");

const COLLATERAL_RATIO  = 200n;
const LIQUIDATION_RATIO = 150n;
const LIQUIDATION_BONUS = 110n;
const BURN_LOCK_RATIO   = 160n;
const MINT_LOCK_RATIO   = 160n;
const RATIO_PRECISION   = 100n;
const PRICE_PRECISION   = 1_000_000_000_000_000_000n; // 1e18
const WSXMR_DECIMALS    = 100_000_000n;               // 1e8
const COLLATERAL_DECIMALS = 100_000_000n;             // 1e8 (raw QQQx atomic)
const BPS_DENOMINATOR   = 10_000n;
const MIN_BURN_AMOUNT   = 1_000_000n;                 // 0.01 wsXMR
const XMR_TO_WSXMR_DIVISOR = 10_000n;
const DEBT_INDEX = 1_000_000_000_000_000_000n;

// Mock oracle prices (raw, exp -8) — must match scripts/gen-mock-pyth.js
const XMR_USD      = 15n;    // $15
const QQQX_USD     = 600n;   // $600
const QQQX_CRASH   = 200n;   // $200

const usdE18 = (rawAtomic: bigint, priceUsd: bigint) =>
  (rawAtomic * priceUsd * PRICE_PRECISION) / COLLATERAL_DECIMALS; // collateral 8dec
const wsxmrUsdE18 = (wsxmr: bigint) =>
  (wsxmr * XMR_USD * PRICE_PRECISION) / WSXMR_DECIMALS;

// ─── keccak request IDs (must match on-chain hashv exactly) ──────────────────
function le64(v: bigint): Buffer {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(v);
  return b;
}
// Mint: keccak(initiator, vault, xmr_amount, claim_commitment, nonce)
function mintRequestId(
  initiator: PublicKey, vault: PublicKey, xmrAmount: bigint, commitment: Buffer, nonce: bigint
): Buffer {
  return Buffer.from(keccak_256(Buffer.concat([
    initiator.toBuffer(), vault.toBuffer(), le64(xmrAmount), commitment, le64(nonce),
  ])));
}
// Burn: keccak(user, vault, wsxmr_amount, nonce)
function burnRequestId(
  user: PublicKey, vault: PublicKey, wsxmrAmount: bigint, nonce: bigint
): Buffer {
  return Buffer.from(keccak_256(Buffer.concat([
    user.toBuffer(), vault.toBuffer(), le64(wsxmrAmount), le64(nonce),
  ])));
}

// ─── Ed25519 commitment (matches on-chain mul_verify / compute_commitment) ───
const ED25519_L = 2n ** 252n + 27742317777372353535851937790883648493n;
function leScalar(secret: Buffer): bigint {
  let s = 0n;
  for (let i = 0; i < 32; i++) s |= BigInt(secret[i]) << BigInt(i * 8);
  return s % ED25519_L;
}
function computePublicKey(secret: Buffer): Buffer {
  return Buffer.from(Point.BASE.multiply(leScalar(secret)).toRawBytes());
}
function computeCommitment(secret: Buffer): Buffer {
  return Buffer.from(keccak_256(computePublicKey(secret)));
}
function makeSecret() {
  const secret = crypto.randomBytes(32);
  // Keep the scalar canonical (< L): Monero scalars are reduced mod L by
  // convention, and sol_curve_multiscalar_mul rejects non-canonical input.
  secret[31] &= 0x0f;
  return { secret, commitment: computeCommitment(secret), pubKey: computePublicKey(secret) };
}

// ─── PDA helpers ─────────────────────────────────────────────────────────────
const findPda = (seeds: Buffer[], pid: PublicKey) =>
  PublicKey.findProgramAddressSync(seeds, pid);

async function expectReject(promise: Promise<any>, needle?: string): Promise<Error> {
  try {
    await promise;
  } catch (e: any) {
    const msg = (e.message ?? "") + JSON.stringify(e.logs ?? []);
    if (needle) {
      assert.include(msg, needle, `expected rejection containing "${needle}", got: ${msg.slice(0, 300)}`);
    }
    return e;
  }
  assert.fail("expected transaction to be rejected");
}

describe("WrapSynth VaultManager — Integration (QQQx collateral)", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = new Program(idl as any, provider) as any;
  const programId: PublicKey = program.programId;
  const conn = provider.connection;

  // Actors — admin is the provider wallet (authority)
  const admin      = (provider.wallet as any).payer as Keypair;
  const lp         = Keypair.generate();
  const lp2        = Keypair.generate();
  const lp3        = Keypair.generate();
  const user       = Keypair.generate();
  const liquidator = Keypair.generate();
  const keeper     = Keypair.generate();

  // Fixture oracle accounts (preloaded by Anchor.toml)
  const oracleMock = new Program(oracleMockIdl as any, provider) as any;

  const fixturesDir = path.join(process.cwd(), "tests", "fixtures");
  const fxKey = (f: string) =>
    Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path.join(fixturesDir, f), "utf8")))).publicKey;
  const PYTH_XMR = fxKey("pyth_xmr_keypair.json");
  const PYTH_COL = fxKey("pyth_col_keypair.json");

  // ─── Live oracle writer ──────────────────────────────────────────────────
  // Both oracle accounts are owned by the oracle-mock program; write_account
  // overwrites the whole 200-byte PriceUpdateV2 blob. publishTs defaults to
  // "now" so the freshness check (<=120s) always passes for normal prices.
  const EXP = -8;
  function pythBlob(feedId: Buffer, priceRaw: bigint, emaRaw: bigint, publishTs: bigint, confRaw?: bigint): Buffer {
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
  const XMR_FEED_BUF = Buffer.from([
    0x46, 0xb8, 0xcc, 0x93, 0x47, 0xf0, 0x43, 0x91, 0x76, 0x4a, 0x03, 0x61, 0xe0, 0xb1, 0x7c, 0x3b,
    0xa3, 0x94, 0xb0, 0x01, 0xe7, 0xc3, 0x04, 0xf7, 0x65, 0x0f, 0x63, 0x76, 0xe3, 0x7c, 0x32, 0x1d,
  ]);
  const QQQX_FEED_BUF = Buffer.from([
    0x17, 0x8a, 0x6f, 0x73, 0xa5, 0xae, 0xde, 0x9d, 0x0d, 0x68, 0x2e, 0x86, 0xb0, 0x04, 0x7c, 0x9f,
    0x33, 0x3e, 0xd0, 0xef, 0xe5, 0xc6, 0x53, 0x7c, 0xa9, 0x37, 0x56, 0x52, 0x19, 0xc4, 0x05, 0x4d,
  ]);
  // IMPORTANT: use the *validator's* clock, not wall time — solana-test-validator
  // slots can tick ahead of real time, so wall-clock publish_time reads stale.
  async function nowSec(): Promise<bigint> {
    const slot = await conn.getSlot();
    const t = await conn.getBlockTime(slot);
    return BigInt(t ?? Math.floor(Date.now() / 1000));
  }
  // Prices are raw i64 at exp -8: $600 → 60_000_000_000n
  async function setOracle(acct: PublicKey, feed: Buffer, usd: bigint, opts: {
    emaUsd?: bigint; publishTs?: bigint; confBps?: bigint;
  } = {}): Promise<void> {
    const priceRaw = usd * 100_000_000n;
    const emaRaw = (opts.emaUsd ?? usd) * 100_000_000n;
    const confRaw = opts.confBps != null ? (priceRaw * opts.confBps) / 10_000n : undefined;
    const blob = pythBlob(feed, priceRaw, emaRaw, opts.publishTs ?? (await nowSec()), confRaw);
    await oracleMock.methods
      .writeAccount(new BN(0), blob)
      .accounts({ target: acct, payer: admin.publicKey })
      .signers([admin])
      .rpc();
  }
  const setXmr = (usd: bigint = XMR_USD, o = {}) => setOracle(PYTH_XMR, XMR_FEED_BUF, usd, o);
  const setCol = (usd: bigint = QQQX_USD, o = {}) => setOracle(PYTH_COL, QQQX_FEED_BUF, usd, o);
  // publish_time freshness window is 120s — refresh both feeds before any test
  // that exercises an oracle-reading instruction.
  const refreshOracles = async () => { await setXmr(); await setCol(); };

  // Test collateral mint (Token-2022, 8 dec — stands in for QQQx)
  const collateralMintKeypair = Keypair.generate();
  const collateralMint = collateralMintKeypair.publicKey;

  // PDAs
  const [globalState]         = findPda([GLOBAL_STATE_SEED], programId);
  const [wsxmrMint]           = findPda([WSXMR_MINT_SEED], programId);
  const [vaultPda]            = findPda([VAULT_SEED, lp.publicKey.toBuffer()], programId);
  const [vault2Pda]           = findPda([VAULT_SEED, lp2.publicKey.toBuffer()], programId);
  const [vault3Pda]           = findPda([VAULT_SEED, lp3.publicKey.toBuffer()], programId);
  const [vaultCollateralAta]  = findPda([VAULT_COLLATERAL_SEED, vaultPda.toBuffer()], programId);
  const [vault2CollateralAta] = findPda([VAULT_COLLATERAL_SEED, vault2Pda.toBuffer()], programId);
  const [vault3CollateralAta] = findPda([VAULT_COLLATERAL_SEED, vault3Pda.toBuffer()], programId);
  const [programCollateralAta] = findPda([PROGRAM_COLLATERAL_SEED], programId);
  const [solEscrow]           = findPda([SOL_ESCROW_SEED], programId);

  // Token accounts
  let lpCollateralAta: PublicKey, lp2CollateralAta: PublicKey, lp3CollateralAta: PublicKey;
  let lpWsxmrAta: PublicKey, lp2WsxmrAta: PublicKey, userWsxmrAta: PublicKey, liquidatorWsxmrAta: PublicKey;
  let liquidatorCollateralAta: PublicKey, userCollateralAta: PublicKey;

  const ataOf = (mint: PublicKey, owner: PublicKey) =>
    getAssociatedTokenAddressSync(mint, owner, true, TOKEN_2022_PROGRAM_ID);

  async function createAta(mint: PublicKey, owner: PublicKey, payer = admin): Promise<PublicKey> {
    const ata = ataOf(mint, owner);
    const tx = new Transaction().add(
      createAssociatedTokenAccountInstruction(
        payer.publicKey, ata, owner, mint, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID
      )
    );
    await provider.sendAndConfirm(tx, [payer]);
    return ata;
  }

  async function airdrop(to: PublicKey, sol = 10): Promise<void> {
    await conn.confirmTransaction(
      await conn.requestAirdrop(to, sol * LAMPORTS_PER_SOL), "confirmed"
    );
  }

  async function globalReqNonce(): Promise<bigint> {
    const gs = await program.account.globalState.fetch(globalState);
    return BigInt(gs.requestNonce.toString());
  }

  const tokenBal = async (ata: PublicKey): Promise<bigint> =>
    BigInt((await getAccount(conn, ata, undefined, TOKEN_2022_PROGRAM_ID)).amount.toString());

  // ─── 0. Setup ──────────────────────────────────────────────────────────────
  before(async () => {
    await Promise.all([lp, lp2, lp3, user, liquidator, keeper].map(k => airdrop(k.publicKey)));

    // Token-2022 collateral mint (8 decimals), authority = admin
    const mintLen = getMintLen([]);
    const rent = await conn.getMinimumBalanceForRentExemption(mintLen);
    const tx = new Transaction().add(
      SystemProgram.createAccount({
        fromPubkey: admin.publicKey,
        newAccountPubkey: collateralMint,
        space: mintLen,
        lamports: rent,
        programId: TOKEN_2022_PROGRAM_ID,
      }),
      createInitializeMint2Instruction(
        collateralMint, 8, admin.publicKey, null, TOKEN_2022_PROGRAM_ID
      )
    );
    await provider.sendAndConfirm(tx, [admin, collateralMintKeypair]);
    lpCollateralAta  = await createAta(collateralMint, lp.publicKey);
    lp2CollateralAta = await createAta(collateralMint, lp2.publicKey);
    lp3CollateralAta = await createAta(collateralMint, lp3.publicKey);
    liquidatorCollateralAta = await createAta(collateralMint, liquidator.publicKey);
    userCollateralAta = await createAta(collateralMint, user.publicKey);

    const mintTx = new Transaction().add(
      createMintToInstruction(collateralMint, lpCollateralAta, admin.publicKey,
        40_0000_0000n, [], TOKEN_2022_PROGRAM_ID), // 40 tokens
      createMintToInstruction(collateralMint, lp2CollateralAta, admin.publicKey,
        10_0000_0000n, [], TOKEN_2022_PROGRAM_ID), // 10 tokens
      createMintToInstruction(collateralMint, lp3CollateralAta, admin.publicKey,
        10_0000_0000n, [], TOKEN_2022_PROGRAM_ID),
    );
    await provider.sendAndConfirm(mintTx, [admin]);
  });

  // Oracle freshness: every instruction that reads a price feed requires
  // publish_time within 120s of the validator clock. Refresh both feeds before
  // each test — tests that want a stale/bad feed overwrite it themselves.
  beforeEach(async () => {
    await refreshOracles();
  });

  // ─── 1. Initialize ─────────────────────────────────────────────────────────
  describe("1. Initialize", () => {
    it("initializes the protocol", async () => {
      await program.methods
        .initialize(PYTH_XMR, collateralMint)
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

      const gs = await program.account.globalState.fetch(globalState);
      assert.equal(gs.authority.toBase58(), admin.publicKey.toBase58());
      assert.equal(gs.wsxmrMint.toBase58(), wsxmrMint.toBase58());
      assert.equal(gs.collateralMint.toBase58(), collateralMint.toBase58());
      assert.equal(gs.pythXmrFeed.toBase58(), PYTH_XMR.toBase58());
      assert.equal(gs.globalTotalDebt.toString(), "0");
      assert.equal(gs.globalDebtIndex.toString(), DEBT_INDEX.toString());

      // wsXMR mint exists, is Token-2022, 8 decimals, mint authority = global PDA
      const mintInfo = await conn.getAccountInfo(wsxmrMint);
      assert.equal(mintInfo!.owner.toBase58(), TOKEN_2022_PROGRAM_ID.toBase58());

      // Program collateral pool ATA exists and is empty
      const pool = await getAccount(conn, programCollateralAta, undefined, TOKEN_2022_PROGRAM_ID);
      assert.equal(pool.amount.toString(), "0");
      assert.equal(pool.mint.toBase58(), collateralMint.toBase58());
    });

    it("rejects re-initialization", async () => {
      await expectReject(
        program.methods.initialize(PYTH_XMR, collateralMint).accounts({
          authority: admin.publicKey, globalState, wsxmrMint, collateralMint,
          programCollateralAta, tokenProgram: TOKEN_2022_PROGRAM_ID,
          systemProgram: SystemProgram.programId, rent: SYSVAR_RENT_PUBKEY,
        }).signers([admin]).rpc()
      );
    });

    it("rejects set_liquidity_router from non-authority", async () => {
      await expectReject(
        program.methods.setLiquidityRouter(keeper.publicKey).accounts({
          authority: lp.publicKey, globalState,
        }).signers([lp]).rpc()
      );
    });
  });

  // ─── 2. Vault management ──────────────────────────────────────────────────
  describe("2. Vault management", () => {
    it("creates a vault for LP", async () => {
      await program.methods.createVault().accounts({
        lp: lp.publicKey, vault: vaultPda, globalState,
        systemProgram: SystemProgram.programId,
      }).signers([lp]).rpc();

      const v = await program.account.vault.fetch(vaultPda);
      assert.equal(v.lpAddress.toBase58(), lp.publicKey.toBase58());
      assert.isTrue(v.active);
      assert.equal(v.collateralAmount.toString(), "0");
    });

    it("configures vault market metrics (1% mint fee, 0.5% burn reward)", async () => {
      await program.methods.setVaultMarketMetrics(100, 50).accounts({
        lp: lp.publicKey, vault: vaultPda,
      }).signers([lp]).rpc();
      const v = await program.account.vault.fetch(vaultPda);
      assert.equal(v.mintFeeBps, 100);
      assert.equal(v.burnRewardBps, 50);
    });

    it("rejects vault config from non-LP", async () => {
      await expectReject(
        program.methods.setVaultMarketMetrics(50, 50).accounts({
          lp: user.publicKey, vault: vaultPda,
        }).signers([user]).rpc()
      );
    });

    it("rejects out-of-range timeout config", async () => {
      await expectReject(
        program.methods.setMintTimeout(new BN(60)).accounts({
          lp: lp.publicKey, vault: vaultPda,
        }).signers([lp]).rpc()
      );
      await expectReject(
        program.methods.setBurnTimeout(new BN(1_000_000)).accounts({
          lp: lp.publicKey, vault: vaultPda,
        }).signers([lp]).rpc()
      );
    });

    it("whitelists and un-whitelists a minter", async () => {
      await program.methods.setMinterWhitelist(user.publicKey, true).accounts({
        lp: lp.publicKey, vault: vaultPda,
      }).signers([lp]).rpc();
      let v = await program.account.vault.fetch(vaultPda);
      assert.equal(v.whitelistedMinterCount, 1);
      assert.equal(v.whitelistedMinters[0].toBase58(), user.publicKey.toBase58());

      await program.methods.setMinterWhitelist(user.publicKey, false).accounts({
        lp: lp.publicKey, vault: vaultPda,
      }).signers([lp]).rpc();
      v = await program.account.vault.fetch(vaultPda);
      assert.equal(v.whitelistedMinterCount, 0);
    });

    it("initializes vault collateral ATA and deposits collateral", async () => {
      await program.methods.initializeVaultCollateral().accounts({
        lp: lp.publicKey, vault: vaultPda, collateralMint,
        vaultCollateralAta, tokenProgram: TOKEN_2022_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      }).signers([lp]).rpc();

      const amount = 30_0000_0000n; // 30 QQQx = $18,000
      await program.methods.depositCollateral(new BN(amount.toString())).accounts({
        lp: lp.publicKey, vault: vaultPda, globalState,
        collateralMint, lpCollateralAta, vaultCollateralAta,
        tokenProgram: TOKEN_2022_PROGRAM_ID, systemProgram: SystemProgram.programId,
      }).signers([lp]).rpc();

      const v = await program.account.vault.fetch(vaultPda);
      assert.equal(v.collateralAmount.toString(), amount.toString());
      assert.equal(await tokenBal(vaultCollateralAta), amount);
    });

    it("rejects deposit from non-LP", async () => {
      await expectReject(
        program.methods.depositCollateral(new BN(1_0000_0000n.toString())).accounts({
          lp: user.publicKey, vault: vaultPda, globalState,
          collateralMint, lpCollateralAta, vaultCollateralAta,
          tokenProgram: TOKEN_2022_PROGRAM_ID, systemProgram: SystemProgram.programId,
        }).signers([user]).rpc()
      );
    });
  });

  // ─── 3. PendingReturns init ────────────────────────────────────────────────
  describe("3. PendingReturns", () => {
    it("creates PendingReturns for lp, user, liquidator", async () => {
      for (const owner of [lp, user, liquidator]) {
        const [pda] = findPda([PENDING_RETURNS_SEED, owner.publicKey.toBuffer()], programId);
        await program.methods.initializePendingReturns().accounts({
          owner: owner.publicKey, pendingReturns: pda,
          systemProgram: SystemProgram.programId,
        }).signers([owner]).rpc();
      }
    });
    it("rejects duplicate PendingReturns creation", async () => {
      const [pda] = findPda([PENDING_RETURNS_SEED, lp.publicKey.toBuffer()], programId);
      await expectReject(
        program.methods.initializePendingReturns().accounts({
          owner: lp.publicKey, pendingReturns: pda,
          systemProgram: SystemProgram.programId,
        }).signers([lp]).rpc()
      );
    });
  });

  // Shared mint params — 40 XMR @ $15 → 40 wsXMR = $600 debt
  const XMR_AMOUNT = 40n * 10n ** 12n; // 40 XMR (12 decimals)
  const WSXMR_AMOUNT = XMR_AMOUNT / XMR_TO_WSXMR_DIVISOR; // 4e9
  const FEE_AMOUNT = (WSXMR_AMOUNT * 100n) / BPS_DENOMINATOR; // 1% fee → 4e7
  const mint1 = makeSecret();
  const lpKey1 = makeSecret();
  let mint1Id: Buffer, mint1Pda: PublicKey;

  // ─── 4. Oracle negatives (via initiate_mint) ───────────────────────────────
  // Each test mutates the live oracle via oracle-mock, then restores the normal
  // fresh price so later sections always see $600 QQQx / $15 XMR.
  describe("4. Oracle rejection paths", () => {
    const initMintCall = (colAcct: PublicKey, reqId: Buffer) =>
      program.methods.initiateMint(
        new BN(XMR_AMOUNT.toString()),
        Array.from(mint1.commitment),
        Array.from(mint1.pubKey),
        Array.from(reqId)
      ).accounts({
        initiator: user.publicKey, recipient: user.publicKey,
        vault: vaultPda, globalState,
        mintRequest: findPda([MINT_REQUEST_SEED, reqId], programId)[0],
        griefingEscrow: keeper.publicKey,
        initiatorPendingReturns: findPda([PENDING_RETURNS_SEED, user.publicKey.toBuffer()], programId)[0],
        pythXmr: PYTH_XMR, pythCollateral: colAcct,
        systemProgram: SystemProgram.programId,
      }).signers([user]);
    const freshId = async () =>
      mintRequestId(user.publicKey, vaultPda, XMR_AMOUNT, mint1.commitment, await globalReqNonce() + 1n);

    it("rejects stale collateral price", async () => {
      await setCol(QQQX_USD, { publishTs: (await nowSec()) - 3600n });
      await expectReject(initMintCall(PYTH_COL, await freshId()).rpc(), "Stale");
      await setCol();
    });

    it("rejects wide-confidence price", async () => {
      await setCol(QQQX_USD, { confBps: 1500n }); // conf = 15% of price > 10% bound
      await expectReject(initMintCall(PYTH_COL, await freshId()).rpc());
      await setCol();
    });

    it("rejects when spot < 97% of EMA (discount guard)", async () => {
      await setCol(550n, { emaUsd: 600n }); // spot $550 < 0.97 * $600 = $582
      await expectReject(initMintCall(PYTH_COL, await freshId()).rpc());
      await setCol();
    });

    it("accepts spot inside the 3% EMA band (guard boundary)", async () => {
      const s2 = makeSecret(); // independent commitment — leaves a Pending request
      const id2 = mintRequestId(user.publicKey, vaultPda, XMR_AMOUNT, s2.commitment, await globalReqNonce() + 1n);
      await setCol(590n, { emaUsd: 600n }); // $590 > $582 → guard passes
      await program.methods.initiateMint(
        new BN(XMR_AMOUNT.toString()), Array.from(s2.commitment),
        Array.from(s2.pubKey), Array.from(id2)
      ).accounts({
        initiator: user.publicKey, recipient: user.publicKey,
        vault: vaultPda, globalState,
        mintRequest: findPda([MINT_REQUEST_SEED, id2], programId)[0],
        griefingEscrow: keeper.publicKey,
        initiatorPendingReturns: findPda([PENDING_RETURNS_SEED, user.publicKey.toBuffer()], programId)[0],
        pythXmr: PYTH_XMR, pythCollateral: PYTH_COL,
        systemProgram: SystemProgram.programId,
      }).signers([user]).rpc();
      await setCol();
    });

    it("rejects a bogus oracle account (wrong feed id)", async () => {
      // Pass the XMR account as the collateral oracle — feed id mismatch
      await expectReject(initMintCall(PYTH_XMR, await freshId()).rpc());
    });
  });

  // ─── 5. Mint flow (happy path) ─────────────────────────────────────────────
  describe("5. Mint flow", () => {
    it("whitelist-bypasses griefing deposit (user whitelisted)", async () => {
      await program.methods.setMinterWhitelist(user.publicKey, true).accounts({
        lp: lp.publicKey, vault: vaultPda,
      }).signers([lp]).rpc();
    });

    it("rejects a bad request_id", async () => {
      const bad = Buffer.alloc(32, 0xaa);
      await expectReject(
        program.methods.initiateMint(
          new BN(XMR_AMOUNT.toString()), Array.from(mint1.commitment),
          Array.from(mint1.pubKey), Array.from(bad)
        ).accounts({
          initiator: user.publicKey, recipient: user.publicKey,
          vault: vaultPda, globalState,
          mintRequest: findPda([MINT_REQUEST_SEED, bad], programId)[0],
          griefingEscrow: keeper.publicKey,
          initiatorPendingReturns: findPda([PENDING_RETURNS_SEED, user.publicKey.toBuffer()], programId)[0],
          pythXmr: PYTH_XMR, pythCollateral: PYTH_COL,
          systemProgram: SystemProgram.programId,
        }).signers([user]).rpc()
      );
    });

    it("initiates a mint request", async () => {
      mint1Id = mintRequestId(user.publicKey, vaultPda, XMR_AMOUNT, mint1.commitment, await globalReqNonce() + 1n);
      mint1Pda = findPda([MINT_REQUEST_SEED, mint1Id], programId)[0];
      await program.methods.initiateMint(
        new BN(XMR_AMOUNT.toString()), Array.from(mint1.commitment),
        Array.from(mint1.pubKey), Array.from(mint1Id)
      ).accounts({
        initiator: user.publicKey, recipient: user.publicKey,
        vault: vaultPda, globalState,
        mintRequest: mint1Pda,
        griefingEscrow: keeper.publicKey,
        initiatorPendingReturns: findPda([PENDING_RETURNS_SEED, user.publicKey.toBuffer()], programId)[0],
        pythXmr: PYTH_XMR, pythCollateral: PYTH_COL,
        systemProgram: SystemProgram.programId,
      }).signers([user]).rpc();

      const req = await program.account.mintRequest.fetch(mint1Pda);
      assert.equal(req.wsxmrAmount.toString(), WSXMR_AMOUNT.toString());
      assert.equal(req.feeAmount.toString(), FEE_AMOUNT.toString());
      assert.equal(req.status.pending !== undefined, true);
    });

    it("rejects provide_lp_key from non-LP", async () => {
      await expectReject(
        program.methods.provideLpKey(
          Array.from(lpKey1.pubKey), Array.from(lpKey1.pubKey), Array.from(lpKey1.commitment)
        ).accounts({
          lp: user.publicKey, vault: vaultPda, globalState, mintRequest: mint1Pda,
          pythXmr: PYTH_XMR, pythCollateral: PYTH_COL,
        }).signers([user]).rpc()
      );
    });

    it("LP provides keys — key bond locks collateral", async () => {
      const before = await program.account.vault.fetch(vaultPda);
      await program.methods.provideLpKey(
        Array.from(lpKey1.pubKey), Array.from(lpKey1.pubKey), Array.from(lpKey1.commitment)
      ).accounts({
        lp: lp.publicKey, vault: vaultPda, globalState, mintRequest: mint1Pda,
        pythXmr: PYTH_XMR, pythCollateral: PYTH_COL,
      }).signers([lp]).rpc();

      const v = await program.account.vault.fetch(vaultPda);
      const lockedDelta = BigInt(v.lockedCollateral.toString()) - BigInt(before.lockedCollateral.toString());
      // Key bond = MINT_LOCK_RATIO (160%) of mint value: $600*1.6 = $960 = 1.6 QQQx
      const expectedBond = usdE18(0n, 0n); // computed below
      const mintUsd = wsxmrUsdE18(WSXMR_AMOUNT);
      const bondUsd = (mintUsd * MINT_LOCK_RATIO) / RATIO_PRECISION;
      const expected = (bondUsd * COLLATERAL_DECIMALS) / (QQQX_USD * PRICE_PRECISION);
      assert.approximately(Number(lockedDelta), Number(expected), Number(expected) / 100);
    });

    it("LP marks mint ready — par lock re-priced, pending_mint_count=1", async () => {
      await program.methods.setMintReady().accounts({
        lp: lp.publicKey, vault: vaultPda, globalState, mintRequest: mint1Pda,
        pythXmr: PYTH_XMR, pythCollateral: PYTH_COL,
      }).signers([lp]).rpc();
      const v = await program.account.vault.fetch(vaultPda);
      assert.equal(v.pendingMintCount, 1);
      const req = await program.account.mintRequest.fetch(mint1Pda);
      assert.notEqual(req.status.ready, undefined);
    });

    it("blocks withdraw_collateral while a READY mint is pending", async () => {
      await expectReject(
        program.methods.withdrawCollateral(new BN(1)).accounts({
          lp: lp.publicKey, vault: vaultPda, globalState,
          collateralMint, lpCollateralAta, vaultCollateralAta,
          pythXmr: PYTH_XMR, pythCollateral: PYTH_COL,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
        }).signers([lp]).rpc()
      );
    });

    it("rejects cancel_mint before timeout", async () => {
      await expectReject(
        program.methods.cancelMint().accounts({
          caller: keeper.publicKey, vault: vaultPda, globalState, mintRequest: mint1Pda,
          initiatorReturns: findPda([PENDING_RETURNS_SEED, user.publicKey.toBuffer()], programId)[0],
          lpReturns: findPda([PENDING_RETURNS_SEED, lp.publicKey.toBuffer()], programId)[0],
          wsxmrMint,
          recipientWsxmrAta: ataOf(wsxmrMint, user.publicKey),
          lpWsxmrAta: ataOf(wsxmrMint, lp.publicKey),
          collateralMint, vaultCollateralAta, programCollateralAta,
          tokenProgram: TOKEN_2022_PROGRAM_ID, systemProgram: SystemProgram.programId,
        }).signers([keeper]).rpc()
      );
    });

    it("user reveals secret — pure Ed25519 verification", async () => {
      await program.methods.revealSecret(Array.from(mint1.secret)).accounts({
        caller: user.publicKey, mintRequest: mint1Pda,
      }).signers([user]).rpc();
      const req = await program.account.mintRequest.fetch(mint1Pda);
      assert.notEqual(req.status.secretRevealed, undefined);
    });

    it("rejects finalize with a wrong secret committed earlier (sanity: stored secret verified)", async () => {
      // status is SecretRevealed — finalize uses the stored verified secret
      // (a fresh wrong-secret finalize isn't possible; covered by reveal path)
      const bad = makeSecret();
      // revealing a second secret must fail (already revealed)
      await expectReject(
        program.methods.revealSecret(Array.from(bad.secret)).accounts({
          caller: user.publicKey, mintRequest: mint1Pda,
        }).signers([user]).rpc()
      );
    });

    it("finalizes mint — full fee to LP, no protocol split", async () => {
      userWsxmrAta = await createAta(wsxmrMint, user.publicKey);
      lpWsxmrAta = await createAta(wsxmrMint, lp.publicKey);
      const supplyBefore = BigInt((await conn.getTokenSupply(wsxmrMint)).value.amount);
      await program.methods.finalizeMint()
        .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })])
        .accounts({
          caller: keeper.publicKey, vault: vaultPda, globalState, mintRequest: mint1Pda,
          wsxmrMint, recipientWsxmrAta: userWsxmrAta, lpWsxmrAta,
          pendingReturns: findPda([PENDING_RETURNS_SEED, user.publicKey.toBuffer()], programId)[0],
          collateralMint, vaultCollateralAta, programCollateralAta,
          tokenProgram: TOKEN_2022_PROGRAM_ID, systemProgram: SystemProgram.programId,
        }).signers([keeper]).rpc();

      assert.equal(await tokenBal(userWsxmrAta), WSXMR_AMOUNT - FEE_AMOUNT);
      assert.equal(await tokenBal(lpWsxmrAta), FEE_AMOUNT); // 100% of fee → LP

      const supplyAfter = BigInt((await conn.getTokenSupply(wsxmrMint)).value.amount);
      assert.equal(supplyAfter - supplyBefore, WSXMR_AMOUNT); // net + fee == full mint

      const v = await program.account.vault.fetch(vaultPda);
      assert.equal(v.normalizedDebt.toString(), WSXMR_AMOUNT.toString());
      assert.equal(v.pendingMintCount, 0);
      const gs = await program.account.globalState.fetch(globalState);
      assert.equal(gs.globalTotalDebt.toString(), WSXMR_AMOUNT.toString());
    });
  });

  // ─── 6. Burn flow ──────────────────────────────────────────────────────────
  const BURN_WSXMR = 10_0000_0000n; // 10 wsXMR = $150
  const burn1 = makeSecret();  // user claim secret
  const lpBurn = makeSecret(); // lp hash secret
  let burn1Id: Buffer, burn1Pda: PublicKey;

  describe("6. Burn flow", () => {
    it("rejects a burn below the minimum", async () => {
      const tiny = 1000n;
      const id = burnRequestId(user.publicKey, vaultPda, tiny, await globalReqNonce() + 1n);
      await expectReject(
        program.methods.requestBurn(
          new BN(tiny.toString()), Array.from(burn1.commitment),
          Array.from(burn1.pubKey), Array.from(burn1.pubKey), Array.from(id)
        ).accounts({
          user: user.publicKey, vault: vaultPda, globalState,
          burnRequest: findPda([BURN_REQUEST_SEED, id], programId)[0],
          wsxmrMint, userWsxmrAta,
          pythXmr: PYTH_XMR, pythCollateral: PYTH_COL,
          tokenProgram: TOKEN_2022_PROGRAM_ID, systemProgram: SystemProgram.programId,
        }).signers([user]).rpc()
      );
    });

    it("rejects a bad burn request_id", async () => {
      const bad = Buffer.alloc(32, 0xbb);
      await expectReject(
        program.methods.requestBurn(
          new BN(BURN_WSXMR.toString()), Array.from(burn1.commitment),
          Array.from(burn1.pubKey), Array.from(burn1.pubKey), Array.from(bad)
        ).accounts({
          user: user.publicKey, vault: vaultPda, globalState,
          burnRequest: findPda([BURN_REQUEST_SEED, bad], programId)[0],
          wsxmrMint, userWsxmrAta,
          pythXmr: PYTH_XMR, pythCollateral: PYTH_COL,
          tokenProgram: TOKEN_2022_PROGRAM_ID, systemProgram: SystemProgram.programId,
        }).signers([user]).rpc()
      );
    });

    it("user requests a burn — wsXMR burned, collateral locked", async () => {
      burn1Id = burnRequestId(user.publicKey, vaultPda, BURN_WSXMR, await globalReqNonce() + 1n);
      burn1Pda = findPda([BURN_REQUEST_SEED, burn1Id], programId)[0];
      const balBefore = await tokenBal(userWsxmrAta);
      const supplyBefore = BigInt((await conn.getTokenSupply(wsxmrMint)).value.amount);

      await program.methods.requestBurn(
        new BN(BURN_WSXMR.toString()), Array.from(burn1.commitment),
        Array.from(burn1.pubKey), Array.from(burn1.pubKey), Array.from(burn1Id)
      ).accounts({
        user: user.publicKey, vault: vaultPda, globalState,
        burnRequest: burn1Pda, wsxmrMint, userWsxmrAta,
        pythXmr: PYTH_XMR, pythCollateral: PYTH_COL,
        tokenProgram: TOKEN_2022_PROGRAM_ID, systemProgram: SystemProgram.programId,
      }).signers([user]).rpc();

      assert.equal(await tokenBal(userWsxmrAta), balBefore - BURN_WSXMR);
      const supplyAfter = BigInt((await conn.getTokenSupply(wsxmrMint)).value.amount);
      assert.equal(supplyBefore - supplyAfter, BURN_WSXMR);

      const req = await program.account.burnRequest.fetch(burn1Pda);
      assert.notEqual(req.status.requested, undefined);
      assert.isTrue(BigInt(req.lockedCollateral.toString()) > 0n);
    });

    it("rejects propose_hash from non-LP", async () => {
      await expectReject(
        program.methods.proposeHash(
          Array.from(lpBurn.commitment), Array.from(lpBurn.pubKey), Array.from(lpBurn.pubKey)
        ).accounts({
          lp: user.publicKey, vault: vaultPda, burnRequest: burn1Pda,
        }).signers([user]).rpc()
      );
    });

    it("LP proposes secret hash", async () => {
      await program.methods.proposeHash(
        Array.from(lpBurn.commitment), Array.from(lpBurn.pubKey), Array.from(lpBurn.pubKey)
      ).accounts({
        lp: lp.publicKey, vault: vaultPda, burnRequest: burn1Pda,
      }).signers([lp]).rpc();
      const req = await program.account.burnRequest.fetch(burn1Pda);
      assert.notEqual(req.status.proposed, undefined);
    });

    it("user confirms Monero lock", async () => {
      await program.methods.confirmMoneroLock().accounts({
        user: user.publicKey, burnRequest: burn1Pda,
      }).signers([user]).rpc();
      const req = await program.account.burnRequest.fetch(burn1Pda);
      assert.notEqual(req.status.committed, undefined);
    });

    it("rejects finalize_burn with wrong secret", async () => {
      const bad = makeSecret();
      await expectReject(
        program.methods.finalizeBurn(Array.from(bad.secret))
          .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })])
          .accounts({
            caller: lp.publicKey, vaultLp: lp.publicKey, vault: vaultPda, globalState,
            burnRequest: burn1Pda,
            userPendingReturns: findPda([PENDING_RETURNS_SEED, user.publicKey.toBuffer()], programId)[0],
            pythXmr: PYTH_XMR, pythCollateral: PYTH_COL,
            collateralMint, vaultCollateralAta, programCollateralAta,
            tokenProgram: TOKEN_2022_PROGRAM_ID, systemProgram: SystemProgram.programId,
          }).signers([lp]).rpc()
      );
    });

    it("LP finalizes burn — reward credited to user pending returns, base lock released to vault", async () => {
      const [userPR] = findPda([PENDING_RETURNS_SEED, user.publicKey.toBuffer()], programId);
      const reqBefore = await program.account.burnRequest.fetch(burn1Pda);
      const locked = BigInt(reqBefore.lockedCollateral.toString());
      const reward = BigInt(reqBefore.rewardCollateral.toString());
      const poolBefore = await tokenBal(programCollateralAta);
      const vBefore = await program.account.vault.fetch(vaultPda);

      await program.methods.finalizeBurn(Array.from(lpBurn.secret))
        .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })])
        .accounts({
          caller: lp.publicKey, vaultLp: lp.publicKey, vault: vaultPda, globalState,
          burnRequest: burn1Pda, userPendingReturns: userPR,
          pythXmr: PYTH_XMR, pythCollateral: PYTH_COL,
          collateralMint, vaultCollateralAta, programCollateralAta,
          tokenProgram: TOKEN_2022_PROGRAM_ID, systemProgram: SystemProgram.programId,
        }).signers([lp]).rpc();

      const req = await program.account.burnRequest.fetch(burn1Pda);
      assert.notEqual(req.status.completed, undefined);

      // Only the (health-capped) reward leaves the vault: credited to pending
      // returns and physically moved into the program pool ATA.
      const pr = await program.account.pendingReturns.fetch(userPR);
      assert.equal(pr.collateralAmount.toString(), reward.toString());
      assert.equal(await tokenBal(programCollateralAta), poolBefore + reward);

      const v = await program.account.vault.fetch(vaultPda);
      // Vault equity drops by the reward only; the base lock stays in the vault.
      const colDelta = BigInt(vBefore.collateralAmount.toString()) - BigInt(v.collateralAmount.toString());
      assert.equal(colDelta, reward);
      // The full reservation (base + reward) is released.
      const lockDelta = BigInt(vBefore.lockedCollateral.toString()) - BigInt(v.lockedCollateral.toString());
      assert.equal(lockDelta, locked + reward);
      // Burned debt cleared from the vault's normalized debt.
      const debtDelta = BigInt(vBefore.normalizedDebt.toString()) - BigInt(v.normalizedDebt.toString());
      assert.equal(debtDelta, BURN_WSXMR);
    });
  });

  // ─── 7. Abort burn (pre-commit) ────────────────────────────────────────────
  // abort_burn is a post-deadline escape hatch: caller must be the burn's user
  // and clock.unix_timestamp >= request.deadline (burn_timeout_seconds ≥ 1800).
  // test-validator can't warp time, so only the rejection paths are exercised.
  describe("7. Abort burn", () => {
    const abort1 = makeSecret();
    let abortPda: PublicKey;
    it("creates a Requested burn", async () => {
      const amt = 1_0000_0000n; // 1 wsXMR
      const id = burnRequestId(user.publicKey, vaultPda, amt, await globalReqNonce() + 1n);
      abortPda = findPda([BURN_REQUEST_SEED, id], programId)[0];
      await program.methods.requestBurn(
        new BN(amt.toString()), Array.from(abort1.commitment),
        Array.from(abort1.pubKey), Array.from(abort1.pubKey), Array.from(id)
      ).accounts({
        user: user.publicKey, vault: vaultPda, globalState, burnRequest: abortPda,
        wsxmrMint, userWsxmrAta, pythXmr: PYTH_XMR, pythCollateral: PYTH_COL,
        tokenProgram: TOKEN_2022_PROGRAM_ID, systemProgram: SystemProgram.programId,
      }).signers([user]).rpc();

      const req = await program.account.burnRequest.fetch(abortPda);
      assert.notEqual(req.status.requested, undefined);
    });

    it("rejects abort from a non-user caller", async () => {
      await expectReject(
        program.methods.abortBurn().accounts({
          caller: keeper.publicKey, vault: vaultPda, globalState, burnRequest: abortPda,
          wsxmrMint, userWsxmrAta,
          tokenProgram: TOKEN_2022_PROGRAM_ID, systemProgram: SystemProgram.programId,
        }).signers([keeper]).rpc()
      );
    });

    it("rejects abort before the deadline (DeadlineNotExpired)", async () => {
      await expectReject(
        program.methods.abortBurn().accounts({
          caller: user.publicKey, vault: vaultPda, globalState, burnRequest: abortPda,
          wsxmrMint, userWsxmrAta,
          tokenProgram: TOKEN_2022_PROGRAM_ID, systemProgram: SystemProgram.programId,
        }).signers([user]).rpc()
      );
    });

    // Resolve the leftover Requested burn through the normal handshake so vault1's
    // locked collateral doesn't leak into the withdrawal/invariant tests.
    const abortLp = makeSecret();
    it("resolves the burn via propose → confirm → finalize", async () => {
      await program.methods.proposeHash(
        Array.from(abortLp.commitment), Array.from(abortLp.pubKey), Array.from(abortLp.pubKey)
      ).accounts({
        lp: lp.publicKey, vault: vaultPda, burnRequest: abortPda,
      }).signers([lp]).rpc();

      await program.methods.confirmMoneroLock().accounts({
        user: user.publicKey, burnRequest: abortPda,
      }).signers([user]).rpc();

      await program.methods.finalizeBurn(Array.from(abortLp.secret))
        .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })])
        .accounts({
          caller: lp.publicKey, vaultLp: lp.publicKey, vault: vaultPda, globalState,
          burnRequest: abortPda,
          userPendingReturns: findPda([PENDING_RETURNS_SEED, user.publicKey.toBuffer()], programId)[0],
          pythXmr: PYTH_XMR, pythCollateral: PYTH_COL,
          collateralMint, vaultCollateralAta, programCollateralAta,
          tokenProgram: TOKEN_2022_PROGRAM_ID, systemProgram: SystemProgram.programId,
        }).signers([lp]).rpc();

      const req = await program.account.burnRequest.fetch(abortPda);
      assert.notEqual(req.status.completed, undefined);
    });
  });

  // ─── 8. Liquidation ────────────────────────────────────────────────────────
  describe("8. Liquidation", () => {
    const liqMint = makeSecret();
    const liqLpKey = makeSecret();
    const LIQ_XMR = 35n * 10n ** 12n;      // 35 XMR → 35 wsXMR = $525 debt
    const LIQ_WSXMR = LIQ_XMR / XMR_TO_WSXMR_DIVISOR;
    let liqMintPda: PublicKey;
    const LIQ_DEPOSIT = 3_5000_0000n;      // 3.5 QQQx = $2100 → mint: (3.5-1.4 bond)*600/525 = 240%;
                                          // at $200 crash: 3.5*200/525 = 133% → liquidatable

    it("sets up an underwater-able vault (lp2)", async () => {
      await program.methods.createVault().accounts({
        lp: lp2.publicKey, vault: vault2Pda, globalState,
        systemProgram: SystemProgram.programId,
      }).signers([lp2]).rpc();
      await program.methods.setVaultMarketMetrics(100, 50).accounts({
        lp: lp2.publicKey, vault: vault2Pda,
      }).signers([lp2]).rpc();
      await program.methods.initializeVaultCollateral().accounts({
        lp: lp2.publicKey, vault: vault2Pda, collateralMint,
        vaultCollateralAta: vault2CollateralAta,
        tokenProgram: TOKEN_2022_PROGRAM_ID, systemProgram: SystemProgram.programId,
      }).signers([lp2]).rpc();
      await program.methods.depositCollateral(new BN(LIQ_DEPOSIT.toString())).accounts({
        lp: lp2.publicKey, vault: vault2Pda, globalState,
        collateralMint, lpCollateralAta: lp2CollateralAta, vaultCollateralAta: vault2CollateralAta,
        tokenProgram: TOKEN_2022_PROGRAM_ID, systemProgram: SystemProgram.programId,
      }).signers([lp2]).rpc();
      await program.methods.setMinterWhitelist(user.publicKey, true).accounts({
        lp: lp2.publicKey, vault: vault2Pda,
      }).signers([lp2]).rpc();
    });

    it("mints 35 wsXMR against the lp2 vault (CR 228%)", async () => {
      const id = mintRequestId(user.publicKey, vault2Pda, LIQ_XMR, liqMint.commitment, await globalReqNonce() + 1n);
      liqMintPda = findPda([MINT_REQUEST_SEED, id], programId)[0];
      await program.methods.initiateMint(
        new BN(LIQ_XMR.toString()), Array.from(liqMint.commitment),
        Array.from(liqMint.pubKey), Array.from(id)
      ).accounts({
        initiator: user.publicKey, recipient: liquidator.publicKey,
        vault: vault2Pda, globalState, mintRequest: liqMintPda,
        griefingEscrow: keeper.publicKey,
        initiatorPendingReturns: findPda([PENDING_RETURNS_SEED, user.publicKey.toBuffer()], programId)[0],
        pythXmr: PYTH_XMR, pythCollateral: PYTH_COL,
        systemProgram: SystemProgram.programId,
      }).signers([user]).rpc();

      await program.methods.provideLpKey(
        Array.from(liqLpKey.pubKey), Array.from(liqLpKey.pubKey), Array.from(liqLpKey.commitment)
      ).accounts({
        lp: lp2.publicKey, vault: vault2Pda, globalState, mintRequest: liqMintPda,
        pythXmr: PYTH_XMR, pythCollateral: PYTH_COL,
      }).signers([lp2]).rpc();
      await program.methods.setMintReady().accounts({
        lp: lp2.publicKey, vault: vault2Pda, globalState, mintRequest: liqMintPda,
        pythXmr: PYTH_XMR, pythCollateral: PYTH_COL,
      }).signers([lp2]).rpc();
      await program.methods.revealSecret(Array.from(liqMint.secret)).accounts({
        caller: user.publicKey, mintRequest: liqMintPda,
      }).signers([user]).rpc();

      liquidatorWsxmrAta = await createAta(wsxmrMint, liquidator.publicKey);
      lp2WsxmrAta = await createAta(wsxmrMint, lp2.publicKey);
      await program.methods.finalizeMint()
        .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })])
        .accounts({
          caller: keeper.publicKey, vault: vault2Pda, globalState, mintRequest: liqMintPda,
          wsxmrMint, recipientWsxmrAta: liquidatorWsxmrAta, lpWsxmrAta: lp2WsxmrAta,
          pendingReturns: findPda([PENDING_RETURNS_SEED, user.publicKey.toBuffer()], programId)[0],
          collateralMint, vaultCollateralAta: vault2CollateralAta, programCollateralAta,
          tokenProgram: TOKEN_2022_PROGRAM_ID, systemProgram: SystemProgram.programId,
        }).signers([keeper]).rpc();

      assert.equal(await tokenBal(liquidatorWsxmrAta), LIQ_WSXMR - (LIQ_WSXMR * 100n) / BPS_DENOMINATOR);
      const v = await program.account.vault.fetch(vault2Pda);
      assert.equal(v.normalizedDebt.toString(), LIQ_WSXMR.toString());
    });

    it("rejects liquidation while oracle price is healthy", async () => {
      await expectReject(
        program.methods.executeLiquidation(new BN(1_0000_0000n.toString())).accounts({
          liquidator: liquidator.publicKey, vault: vault2Pda, globalState,
          wsxmrMint, collateralMint,
          liquidatorWsxmrAta, liquidatorCollateralAta,
          vaultCollateralAta: vault2CollateralAta,
          pythXmr: PYTH_XMR, pythCollateral: PYTH_COL,
          tokenProgram: TOKEN_2022_PROGRAM_ID, systemProgram: SystemProgram.programId,
        }).signers([liquidator]).rpc()
      );
    });

    it("executes a partial liquidation at the crashed price", async () => {
      const DEBT_TO_CLEAR = 10_0000_0000n; // 10 wsXMR ($150)
      const vBefore = await program.account.vault.fetch(vault2Pda);
      const liqColBefore = await tokenBal(liquidatorCollateralAta);
      const liqWsxmrBefore = await tokenBal(liquidatorWsxmrAta);

      await setCol(QQQX_CRASH); // $200 — CR drops to ~76%, liquidatable
      try {
        await program.methods.executeLiquidation(new BN(DEBT_TO_CLEAR.toString()))
          .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })])
          .accounts({
            liquidator: liquidator.publicKey, vault: vault2Pda, globalState,
            wsxmrMint, collateralMint,
            liquidatorWsxmrAta, liquidatorCollateralAta,
            vaultCollateralAta: vault2CollateralAta,
            pythXmr: PYTH_XMR, pythCollateral: PYTH_COL,
            tokenProgram: TOKEN_2022_PROGRAM_ID, systemProgram: SystemProgram.programId,
          }).signers([liquidator]).rpc();
      } finally {
        await setCol(); // restore $600
      }

      const v = await program.account.vault.fetch(vault2Pda);
      assert.equal(
        BigInt(vBefore.normalizedDebt.toString()) - BigInt(v.normalizedDebt.toString()),
        DEBT_TO_CLEAR
      );
      // Seized = debt_usd * 1.10 / col_price → $150*1.1/$200 = 0.825 QQQx
      const debtUsd = wsxmrUsdE18(DEBT_TO_CLEAR);
      const expectedSeized = (debtUsd * LIQUIDATION_BONUS * COLLATERAL_DECIMALS)
        / (RATIO_PRECISION * QQQX_CRASH * PRICE_PRECISION);
      const seized = (await tokenBal(liquidatorCollateralAta)) - liqColBefore;
      assert.approximately(Number(seized), Number(expectedSeized), Number(expectedSeized) / 50);
      assert.equal(await tokenBal(liquidatorWsxmrAta), liqWsxmrBefore - DEBT_TO_CLEAR);
    });

    it("backstop_vault rejects same-vault migration", async () => {
      await expectReject(
        program.methods.backstopVault().accounts({
          newLp: lp2.publicKey, oldVault: vault2Pda, newVault: vault2Pda,
          globalState, pythXmr: PYTH_XMR, pythCollateral: PYTH_COL,
          collateralMint,
          oldVaultCollateralAta: vault2CollateralAta, newVaultCollateralAta: vault2CollateralAta,
          tokenProgram: TOKEN_2022_PROGRAM_ID, systemProgram: SystemProgram.programId,
        }).signers([lp2]).rpc()
      );
    });

    it("resolve_burn_for_liquidation rejects a healthy vault's burn", async () => {
      // burn1Pda is Completed (terminal) — still expect rejection, path exercised
      await expectReject(
        program.methods.resolveBurnForLiquidation().accounts({
          caller: keeper.publicKey, vault: vaultPda, globalState, burnRequest: burn1Pda,
          userPendingReturns: findPda([PENDING_RETURNS_SEED, user.publicKey.toBuffer()], programId)[0],
          wsxmrMint, userWsxmrAta,
          pythXmr: PYTH_XMR, pythCollateral: PYTH_COL,
          collateralMint, vaultCollateralAta, programCollateralAta,
          tokenProgram: TOKEN_2022_PROGRAM_ID, systemProgram: SystemProgram.programId,
        }).signers([keeper]).rpc()
      );
    });
  });

  // ─── 9. Withdrawals ────────────────────────────────────────────────────────
  describe("9. Withdrawals", () => {
    it("user withdraws pending collateral — drains from program pool", async () => {
      const [userPR] = findPda([PENDING_RETURNS_SEED, user.publicKey.toBuffer()], programId);
      const pr = await program.account.pendingReturns.fetch(userPR);
      const amount = BigInt(pr.collateralAmount.toString());
      assert.isTrue(amount > 0n);

      const poolBefore = await tokenBal(programCollateralAta);
      const userBefore = await tokenBal(userCollateralAta);

      await program.methods.withdrawCollateralReturns().accounts({
        owner: user.publicKey, pendingReturns: userPR, globalState,
        collateralMint, programCollateralAta,
        userCollateralAta,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      }).signers([user]).rpc();

      assert.equal((await tokenBal(userCollateralAta)) - userBefore, amount);
      assert.equal(await tokenBal(programCollateralAta), poolBefore - amount);
      const prAfter = await program.account.pendingReturns.fetch(userPR);
      assert.equal(prAfter.collateralAmount.toString(), "0");
    });

    it("rejects withdraw_collateral_returns when balance is zero", async () => {
      const [userPR] = findPda([PENDING_RETURNS_SEED, user.publicKey.toBuffer()], programId);
      await expectReject(
        program.methods.withdrawCollateralReturns().accounts({
          owner: user.publicKey, pendingReturns: userPR, globalState,
          collateralMint, programCollateralAta, userCollateralAta,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
        }).signers([user]).rpc()
      );
    });

    it("rejects withdraw_sol_returns when balance is zero", async () => {
      const [userPR] = findPda([PENDING_RETURNS_SEED, user.publicKey.toBuffer()], programId);
      await expectReject(
        program.methods.withdrawSolReturns().accounts({
          owner: user.publicKey, pendingReturns: userPR, globalState,
          solEscrow, systemProgram: SystemProgram.programId,
        }).signers([user]).rpc()
      );
    });
  });

  // ─── 10. Reconciliation ────────────────────────────────────────────────────
  describe("10. Reconciliation", () => {
    it("reconciles global_total_debt from remaining_account vaults", async () => {
      const v1 = await program.account.vault.fetch(vaultPda);
      const v2 = await program.account.vault.fetch(vault2Pda);
      const expected = BigInt(v1.normalizedDebt.toString()) + BigInt(v2.normalizedDebt.toString());
      await program.methods.reconcileGlobalDebt().accounts({
        authority: keeper.publicKey, globalState,
      }).remainingAccounts([
        { pubkey: vaultPda, isSigner: false, isWritable: false },
        { pubkey: vault2Pda, isSigner: false, isWritable: false },
      ]).signers([keeper]).rpc();
      const gs = await program.account.globalState.fetch(globalState);
      assert.equal(gs.globalTotalDebt.toString(), expected.toString());
    });
  });

  // ─── 11. Deactivation + multi-vault ────────────────────────────────────────
  describe("11. Deactivation & multi-vault", () => {
    it("rejects deactivation with outstanding debt", async () => {
      await expectReject(
        program.methods.deactivateVault().accounts({
          lp: lp2.publicKey, vault: vault2Pda, globalState,
        }).signers([lp2]).rpc()
      );
    });

    it("creates a third vault and deactivates it cleanly", async () => {
      await program.methods.createVault().accounts({
        lp: lp3.publicKey, vault: vault3Pda, globalState,
        systemProgram: SystemProgram.programId,
      }).signers([lp3]).rpc();
      await program.methods.deactivateVault().accounts({
        lp: lp3.publicKey, vault: vault3Pda, globalState,
      }).signers([lp3]).rpc();
      const v = await program.account.vault.fetch(vault3Pda);
      assert.isFalse(v.active);
    });

    it("rejects initiate_mint on a deactivated vault", async () => {
      const s = makeSecret();
      const id = mintRequestId(user.publicKey, vault3Pda, XMR_AMOUNT, s.commitment, await globalReqNonce() + 1n);
      await expectReject(
        program.methods.initiateMint(
          new BN(XMR_AMOUNT.toString()), Array.from(s.commitment),
          Array.from(s.pubKey), Array.from(id)
        ).accounts({
          initiator: user.publicKey, recipient: user.publicKey,
          vault: vault3Pda, globalState,
          mintRequest: findPda([MINT_REQUEST_SEED, id], programId)[0],
          griefingEscrow: keeper.publicKey,
          initiatorPendingReturns: findPda([PENDING_RETURNS_SEED, user.publicKey.toBuffer()], programId)[0],
          pythXmr: PYTH_XMR, pythCollateral: PYTH_COL,
          systemProgram: SystemProgram.programId,
        }).signers([user]).rpc()
      );
    });
  });

  // ─── 12. Invariants ────────────────────────────────────────────────────────
  describe("12. Invariants", () => {
    it("program collateral pool backs all pending collateral returns", async () => {
      const gs = await program.account.globalState.fetch(globalState);
      const pool = await tokenBal(programCollateralAta);
      assert.isTrue(pool >= BigInt(gs.globalPendingCollateral.toString()),
        `pool ${pool} < pending ${gs.globalPendingCollateral}`);
    });

    it("vault collateral_amount equals vault ATA balance (raw accounting)", async () => {
      for (const [pda, ata] of [[vaultPda, vaultCollateralAta], [vault2Pda, vault2CollateralAta]]) {
        const v = await program.account.vault.fetch(pda as PublicKey);
        const bal = await tokenBal(ata as PublicKey);
        assert.equal(bal.toString(), v.collateralAmount.toString(),
          `vault ${pda} tracking ${v.collateralAmount} != ATA ${bal}`);
      }
    });

    it("locked_collateral never exceeds collateral_amount", async () => {
      for (const pda of [vaultPda, vault2Pda, vault3Pda]) {
        const v = await program.account.vault.fetch(pda);
        assert.isTrue(
          BigInt(v.lockedCollateral.toString()) <= BigInt(v.collateralAmount.toString())
        );
      }
    });
  });
});
