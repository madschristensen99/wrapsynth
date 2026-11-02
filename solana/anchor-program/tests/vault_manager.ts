/**
 * WrapSynth VaultManager — Integration Test Suite (oracle-free, SOL collateral)
 *
 * Covers:
 *   1. Protocol initialization
 *   2. Vault creation + threshold/max-mint config + SOL collateral deposit
 *   3. Full mint flow:  initiate → provide_lp_key → set_mint_ready → reveal → finalize
 *   4. Mint negatives: bad request_id, under-collateralized at declared threshold
 *   5. Full burn flow:  request → propose_hash → confirm_monero_lock → finalize_burn
 *   6. Burn negatives + abort (pre-commit deadline path)
 *   7. Auction lifecycle: kick → grace cancel → re-kick → open → bid (whole-debt)
 *   8. Auction expiry: ENDED kick → resolve → frozen → backstop_vault
 *   9. repay_debt (LP debt retirement)
 *  10. Withdrawals: pending-returns claims backed by the program collateral pool
 *
 * Oracle-free model: there is no price feed. Each LP declares a collateral
 * threshold — lamports of SOL per 1e8 wsXMR — which governs mint capacity,
 * coverage, and par settlement. Liquidation is a permissionless bonded-kick
 * Dutch auction (EVM Kick parity).
 *
 * Timing: this suite MUST run against a program built with the
 * `test-lifecycle` cargo feature (cargo build-sbf --features test-lifecycle),
 * which shrinks the auction windows to seconds.
 */

import * as anchor from "@coral-xyz/anchor";
import { Program, AnchorProvider, BN } from "@coral-xyz/anchor";
import {
  Keypair,
  PublicKey,
  SystemProgram,
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
  createTransferInstruction,
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

// ─── Constants mirrored from constants.rs (test-lifecycle build) ─────────────
const GLOBAL_STATE_SEED       = Buffer.from("global_state");
const VAULT_SEED              = Buffer.from("vault");
const WSXMR_MINT_SEED         = Buffer.from("wsxmr_mint");
const MINT_REQUEST_SEED       = Buffer.from("mint_request");
const BURN_REQUEST_SEED       = Buffer.from("burn_request");
const PENDING_RETURNS_SEED    = Buffer.from("pending_returns");
const VAULT_COLLATERAL_SEED   = Buffer.from("vault_collateral");
const PROGRAM_COLLATERAL_SEED = Buffer.from("program_collateral");
const AUCTION_SEED            = Buffer.from("auction");
const AUCTION_BOND_SEED       = Buffer.from("auction_bond");

const WSXMR_DECIMALS       = 100_000_000n;  // 1e8
const DEBT_INDEX           = 1_000_000_000_000_000_000n; // 1e18
const BPS_DENOMINATOR      = 10_000n;
const XMR_TO_WSXMR_DIVISOR = 10_000n;
const MINT_LOCK_RATIO      = 110n;
const RATIO_PRECISION      = 100n;
const BURN_LOCK_MULT_BPS   = 13_000n;
const MIN_BURN_AMOUNT      = 1_000_000n;    // 0.01 wsXMR
const KICK_BOND_BPS        = 200n;
const KICK_BOND_MIN        = 50_000_000n;   // 0.05 SOL
const KICK_GRACE_S         = 15;            // test-lifecycle
const OPEN_DELAY_S         = 10;
const AUCTION_DURATION_S   = 60;
const KICK_COOLDOWN_S      = 10;

/** LP-declared threshold: lamports of SOL per 1e8 wsXMR. 1.5 SOL ≈ par. */
const THRESHOLD = 1_500_000_000n;

const par = (wsxmr: bigint, t: bigint = THRESHOLD) => (wsxmr * t) / WSXMR_DECIMALS;
const parLock = (wsxmr: bigint, t: bigint = THRESHOLD) =>
  (par(wsxmr, t) * MINT_LOCK_RATIO) / RATIO_PRECISION;
const kickBond = (collateral: bigint) => {
  const b = (collateral * KICK_BOND_BPS) / BPS_DENOMINATOR;
  return b > KICK_BOND_MIN ? b : KICK_BOND_MIN;
};

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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("WrapSynth VaultManager — Integration (oracle-free)", () => {
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

  // PDAs
  const [globalState]          = findPda([GLOBAL_STATE_SEED], programId);
  const [wsxmrMint]            = findPda([WSXMR_MINT_SEED], programId);
  const [vaultPda]             = findPda([VAULT_SEED, lp.publicKey.toBuffer()], programId);
  const [vault2Pda]            = findPda([VAULT_SEED, lp2.publicKey.toBuffer()], programId);
  const [vault3Pda]            = findPda([VAULT_SEED, lp3.publicKey.toBuffer()], programId);
  const [vaultEscrow]          = findPda([VAULT_COLLATERAL_SEED, vaultPda.toBuffer()], programId);
  const [vault2Escrow]         = findPda([VAULT_COLLATERAL_SEED, vault2Pda.toBuffer()], programId);
  const [vault3Escrow]         = findPda([VAULT_COLLATERAL_SEED, vault3Pda.toBuffer()], programId);
  const [programCollateralAta] = findPda([PROGRAM_COLLATERAL_SEED], programId);
  const auctionPdaOf = (v: PublicKey) => findPda([AUCTION_SEED, v.toBuffer()], programId)[0];
  const bondEscrowOf = (v: PublicKey) => findPda([AUCTION_BOND_SEED, v.toBuffer()], programId)[0];

  // Token accounts
  let lpWsxmrAta: PublicKey, lp2WsxmrAta: PublicKey, lp3WsxmrAta: PublicKey,
      userWsxmrAta: PublicKey, liquidatorWsxmrAta: PublicKey;

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

  const lamports = async (pk: PublicKey): Promise<bigint> =>
    BigInt(await conn.getBalance(pk));

  const vaultState = (v: PublicKey) => program.account.vault.fetch(v);
  const auctionState = (v: PublicKey) => program.account.auction.fetch(auctionPdaOf(v));

  /** deposit_collateral — passes the auction+bond escrow only when the vault
   *  has a live kick (required for the GRACE cancel; absent otherwise). */
  async function deposit(lpKp: Keypair, vpda: PublicKey, escrow: PublicKey, amount: bigint) {
    const v = await vaultState(vpda).catch(() => null);
    const kicked = v?.kickActive === true;
    return program.methods.depositCollateral(new BN(amount.toString())).accounts({
      lp: lpKp.publicKey,
      vault: vpda,
      globalState,
      vaultCollateralEscrow: escrow,
      auction: kicked ? auctionPdaOf(vpda) : null,
      bondEscrow: kicked ? bondEscrowOf(vpda) : null,
      systemProgram: SystemProgram.programId,
    }).signers([lpKp]).rpc();
  }

  /** Run the mint handshake up to (but not including) reveal_secret. */
  async function driveMintToReady(
    vpda: PublicKey, lpKp: Keypair, recipient: PublicKey, xmrAmount: bigint,
  ) {
    const uSecret = makeSecret();
    const nonce = (await globalReqNonce()) + 1n;
    const id = mintRequestId(user.publicKey, vpda, xmrAmount, uSecret.commitment, nonce);
    const pda = findPda([MINT_REQUEST_SEED, id], programId)[0];
    await program.methods.initiateMint(
      new BN(xmrAmount.toString()), Array.from(uSecret.commitment),
      Array.from(uSecret.pubKey), Array.from(id)
    ).accounts({
      initiator: user.publicKey, recipient,
      vault: vpda, globalState, mintRequest: pda,
      griefingEscrow: lpKp.publicKey,
      initiatorPendingReturns: findPda([PENDING_RETURNS_SEED, user.publicKey.toBuffer()], programId)[0],
      systemProgram: SystemProgram.programId,
    }).signers([user]).rpc();

    const lpSecret = makeSecret();
    await program.methods.provideLpKey(
      Array.from(lpSecret.pubKey), Array.from(lpSecret.pubKey), Array.from(lpSecret.commitment)
    ).accounts({
      lp: lpKp.publicKey, vault: vpda, globalState, mintRequest: pda,
    }).signers([lpKp]).rpc();

    await program.methods.setMintReady().accounts({
      lp: lpKp.publicKey, vault: vpda, globalState, mintRequest: pda,
    }).signers([lpKp]).rpc();

    return { pda, id, uSecret, lpSecret };
  }

  /** Drive a burn to Committed (request → propose → confirm). */
  async function driveBurnToCommitted(
    vpda: PublicKey, lpKp: Keypair, wsxmr: bigint,
  ) {
    const uSecret = makeSecret();
    const nonce = (await globalReqNonce()) + 1n;
    const id = burnRequestId(user.publicKey, vpda, wsxmr, nonce);
    const pda = findPda([BURN_REQUEST_SEED, id], programId)[0];
    await program.methods.requestBurn(
      new BN(wsxmr.toString()), Array.from(uSecret.commitment),
      Array.from(uSecret.pubKey), Array.from(uSecret.pubKey), Array.from(id)
    ).accounts({
      user: user.publicKey, vault: vpda, globalState, burnRequest: pda,
      wsxmrMint, userWsxmrAta,
      tokenProgram: TOKEN_2022_PROGRAM_ID, systemProgram: SystemProgram.programId,
    }).signers([user]).rpc();

    const lpSecret = makeSecret();
    await program.methods.proposeHash(
      Array.from(lpSecret.commitment), Array.from(lpSecret.pubKey), Array.from(lpSecret.pubKey)
    ).accounts({ lp: lpKp.publicKey, vault: vpda, burnRequest: pda }).signers([lpKp]).rpc();

    await program.methods.confirmMoneroLock().accounts({
      user: user.publicKey, burnRequest: pda,
    }).signers([user]).rpc();

    return { pda, id, uSecret, lpSecret };
  }

  // ─── 0. Setup ──────────────────────────────────────────────────────────────
  before(async () => {
    await Promise.all([lp, lp2, lp3, user, liquidator, keeper].map(k => airdrop(k.publicKey)));
  });

  // ─── 1. Initialize ─────────────────────────────────────────────────────────
  describe("1. Initialize", () => {
    it("initializes the protocol (no oracle arguments)", async () => {
      await program.methods.initialize().accounts({
        authority: admin.publicKey,
        globalState,
        wsxmrMint,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      }).rpc();
      const gs = await program.account.globalState.fetch(globalState);
      assert.equal(gs.authority.toBase58(), admin.publicKey.toBase58());
      assert.equal(gs.wsxmrMint.toBase58(), wsxmrMint.toBase58());
      assert.equal(gs.globalDebtIndex.toString(), DEBT_INDEX.toString());
    });

    it("rejects re-initialization", async () => {
      await expectReject(program.methods.initialize().accounts({
        authority: admin.publicKey,
        globalState,
        wsxmrMint,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      }).rpc());
    });

    it("rejects set_liquidity_router from non-authority", async () => {
      await expectReject(
        program.methods.setLiquidityRouter(user.publicKey).accounts({
          authority: user.publicKey, globalState,
        }).signers([user]).rpc(),
        "OnlyDeployer"
      );
    });
  });

  // ─── 2. Vault management ───────────────────────────────────────────────────
  describe("2. Vault management", () => {
    it("creates a vault for LP", async () => {
      await program.methods.createVault().accounts({
        lp: lp.publicKey, vault: vaultPda, globalState,
        systemProgram: SystemProgram.programId,
      }).signers([lp]).rpc();
      const v = await vaultState(vaultPda);
      assert.isTrue(v.active);
      assert.equal(v.collateralAmount.toString(), "0");
    });

    it("rejects a threshold below the minimum", async () => {
      await expectReject(
        program.methods.setThreshold(new BN("1")).accounts({
          lp: lp.publicKey, vault: vaultPda,
        }).signers([lp]).rpc(),
        "BelowMinThreshold"
      );
    });

    it("sets the LP-declared threshold (1.5 SOL per wsXMR)", async () => {
      await program.methods.setThreshold(new BN(THRESHOLD.toString())).accounts({
        lp: lp.publicKey, vault: vaultPda,
      }).signers([lp]).rpc();
      const v = await vaultState(vaultPda);
      assert.equal(v.thresholdLamportsPerWsxmr.toString(), THRESHOLD.toString());
    });

    it("sets the absolute mint cap and market metrics", async () => {
      await program.methods.setMaxMintWsxmr(new BN("0")).accounts({
        lp: lp.publicKey, vault: vaultPda,
      }).signers([lp]).rpc();
      await program.methods.setVaultMarketMetrics(100, 50).accounts({
        lp: lp.publicKey, vault: vaultPda,
      }).signers([lp]).rpc();
      const v = await vaultState(vaultPda);
      assert.equal(v.mintFeeBps, 100);
      assert.equal(v.burnRewardBps, 50);
    });

    it("rejects vault config from non-LP", async () => {
      await expectReject(
        program.methods.setThreshold(new BN(THRESHOLD.toString())).accounts({
          lp: user.publicKey, vault: vaultPda,
        }).signers([user]).rpc()
      );
    });

    it("whitelists and un-whitelists a minter", async () => {
      await program.methods.setMinterWhitelist(user.publicKey, true).accounts({
        lp: lp.publicKey, vault: vaultPda,
      }).signers([lp]).rpc();
      let v = await vaultState(vaultPda);
      assert.equal(v.whitelistedMinterCount, 1);
      await program.methods.setMinterWhitelist(user.publicKey, false).accounts({
        lp: lp.publicKey, vault: vaultPda,
      }).signers([lp]).rpc();
      v = await vaultState(vaultPda);
      assert.equal(v.whitelistedMinterCount, 0);
      await program.methods.setMinterWhitelist(user.publicKey, true).accounts({
        lp: lp.publicKey, vault: vaultPda,
      }).signers([lp]).rpc();
    });

    it("deposits native SOL collateral (lamports tracked 1:1)", async () => {
      const amt = 4_000_000_000n; // 4 SOL
      const before = await lamports(vaultEscrow).catch(() => 0n);
      await program.methods.depositCollateral(new BN(amt.toString())).accounts({
        lp: lp.publicKey, vault: vaultPda, globalState,
        vaultCollateralEscrow: vaultEscrow,
        auction: null, bondEscrow: null,
        systemProgram: SystemProgram.programId,
      }).signers([lp]).rpc();
      const v = await vaultState(vaultPda);
      assert.equal(v.collateralAmount.toString(), amt.toString());
      assert.equal(await lamports(vaultEscrow) - before, amt);
    });

    it("rejects deposit to a vault the signer does not own", async () => {
      await expectReject(
        program.methods.depositCollateral(new BN("1000000")).accounts({
          lp: user.publicKey, vault: vaultPda, globalState,
          vaultCollateralEscrow: vaultEscrow,
          auction: null, bondEscrow: null,
          systemProgram: SystemProgram.programId,
        }).signers([user]).rpc()
      );
    });

    it("withdraws SOL collateral", async () => {
      await program.methods.withdrawCollateral(new BN("500000000")).accounts({
        lp: lp.publicKey, vault: vaultPda, globalState,
        vaultCollateralEscrow: vaultEscrow,
        systemProgram: SystemProgram.programId,
      }).signers([lp]).rpc();
      const v = await vaultState(vaultPda);
      assert.equal(v.collateralAmount.toString(), "3500000000");
    });
  });

  // ─── 3. PendingReturns ─────────────────────────────────────────────────────
  describe("3. PendingReturns", () => {
    it("creates PendingReturns for lp, user, liquidator", async () => {
      for (const k of [lp, user, liquidator]) {
        const [pda] = findPda([PENDING_RETURNS_SEED, k.publicKey.toBuffer()], programId);
        await program.methods.initializePendingReturns().accounts({
          owner: k.publicKey, pendingReturns: pda,
          systemProgram: SystemProgram.programId,
        }).signers([k]).rpc();
      }
    });

    it("rejects duplicate PendingReturns creation", async () => {
      const [pda] = findPda([PENDING_RETURNS_SEED, user.publicKey.toBuffer()], programId);
      await expectReject(program.methods.initializePendingReturns().accounts({
        owner: user.publicKey, pendingReturns: pda,
        systemProgram: SystemProgram.programId,
      }).signers([user]).rpc());
    });
  });

  // ─── 4. Mint flow ──────────────────────────────────────────────────────────
  describe("4. Mint flow", () => {
    const XMR_AMOUNT = 1_000_000_000_000n;  // 1 XMR (12 dec) → 1 wsXMR
    const WSXMR_MINTED = XMR_AMOUNT / XMR_TO_WSXMR_DIVISOR; // 1e8
    let mintPda: PublicKey;
    let mintId: Buffer;
    let uSecret: ReturnType<typeof makeSecret>;
    let lpSecret: ReturnType<typeof makeSecret>;

    it("rejects a bad request_id", async () => {
      const s = makeSecret();
      const badId = crypto.randomBytes(32);
      const badPda = findPda([MINT_REQUEST_SEED, badId], programId)[0];
      await expectReject(
        program.methods.initiateMint(
          new BN(XMR_AMOUNT.toString()), Array.from(s.commitment),
          Array.from(s.pubKey), Array.from(badId)
        ).accounts({
          initiator: user.publicKey, recipient: user.publicKey,
          vault: vaultPda, globalState, mintRequest: badPda,
          griefingEscrow: lp.publicKey,
          initiatorPendingReturns: findPda([PENDING_RETURNS_SEED, user.publicKey.toBuffer()], programId)[0],
          systemProgram: SystemProgram.programId,
        }).signers([user]).rpc(),
        "InvalidMintRequest"
      );
    });

    it("initiates a mint request (whitelist bypasses griefing deposit)", async () => {
      uSecret = makeSecret();
      const nonce = (await globalReqNonce()) + 1n;
      mintId = mintRequestId(user.publicKey, vaultPda, XMR_AMOUNT, uSecret.commitment, nonce);
      mintPda = findPda([MINT_REQUEST_SEED, mintId], programId)[0];
      await program.methods.initiateMint(
        new BN(XMR_AMOUNT.toString()), Array.from(uSecret.commitment),
        Array.from(uSecret.pubKey), Array.from(mintId)
      ).accounts({
        initiator: user.publicKey, recipient: user.publicKey,
        vault: vaultPda, globalState, mintRequest: mintPda,
        griefingEscrow: lp.publicKey,
        initiatorPendingReturns: findPda([PENDING_RETURNS_SEED, user.publicKey.toBuffer()], programId)[0],
        systemProgram: SystemProgram.programId,
      }).signers([user]).rpc();
      const req = await program.account.mintRequest.fetch(mintPda);
      assert.equal(req.wsxmrAmount.toString(), WSXMR_MINTED.toString());
    });

    it("rejects provide_lp_key from non-LP", async () => {
      const s = makeSecret();
      await expectReject(
        program.methods.provideLpKey(
          Array.from(s.pubKey), Array.from(s.pubKey), Array.from(s.commitment)
        ).accounts({
          lp: user.publicKey, vault: vaultPda, globalState, mintRequest: mintPda,
        }).signers([user]).rpc()
      );
    });

    it("LP provides keys — par key bond locks at the declared threshold", async () => {
      lpSecret = makeSecret();
      await program.methods.provideLpKey(
        Array.from(lpSecret.pubKey), Array.from(lpSecret.pubKey), Array.from(lpSecret.commitment)
      ).accounts({
        lp: lp.publicKey, vault: vaultPda, globalState, mintRequest: mintPda,
      }).signers([lp]).rpc();
      const v = await vaultState(vaultPda);
      assert.equal(
        v.lockedCollateral.toString(),
        parLock(WSXMR_MINTED).toString()
      );
      assert.equal(v.pendingDebt.toString(), WSXMR_MINTED.toString());
    });

    it("LP marks mint ready — threshold snapshot stored", async () => {
      await program.methods.setMintReady().accounts({
        lp: lp.publicKey, vault: vaultPda, globalState, mintRequest: mintPda,
      }).signers([lp]).rpc();
      const req = await program.account.mintRequest.fetch(mintPda);
      assert.equal(req.thresholdAtReady.toString(), THRESHOLD.toString());
      const v = await vaultState(vaultPda);
      assert.equal(v.pendingMintCount, 1);
    });

    it("blocks withdraw_collateral while a READY mint is pending", async () => {
      await expectReject(
        program.methods.withdrawCollateral(new BN("1")).accounts({
          lp: lp.publicKey, vault: vaultPda, globalState,
          vaultCollateralEscrow: vaultEscrow,
          systemProgram: SystemProgram.programId,
        }).signers([lp]).rpc(),
        "PendingMintLock"
      );
    });

    it("rejects cancel_mint before timeout", async () => {
      await expectReject(
        program.methods.cancelMint().accounts({
          caller: user.publicKey, vault: vaultPda, globalState, mintRequest: mintPda,
          initiatorReturns: findPda([PENDING_RETURNS_SEED, user.publicKey.toBuffer()], programId)[0],
          lpReturns: findPda([PENDING_RETURNS_SEED, lp.publicKey.toBuffer()], programId)[0],
          wsxmrMint,
          recipientWsxmrAta: ataOf(wsxmrMint, user.publicKey),
          lpWsxmrAta: ataOf(wsxmrMint, lp.publicKey),
          vaultCollateralEscrow: vaultEscrow,
          collateralEscrow: programCollateralAta,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        }).signers([user]).rpc()
      );
    });

    it("user reveals secret — pure Ed25519 verification", async () => {
      userWsxmrAta = await createAta(wsxmrMint, user.publicKey);
      lpWsxmrAta = await createAta(wsxmrMint, lp.publicKey);
      await program.methods.revealSecret(Array.from(uSecret.secret)).accounts({
        caller: user.publicKey, mintRequest: mintPda,
      }).signers([user]).rpc();
      const req = await program.account.mintRequest.fetch(mintPda);
      assert.isTrue('secretRevealed' in req.status);
    });

    it("finalizes mint — net wsXMR to user, fee to LP", async () => {
      await program.methods.finalizeMint()
        .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })])
        .accounts({
          caller: user.publicKey, vault: vaultPda, globalState, mintRequest: mintPda,
          wsxmrMint,
          recipientWsxmrAta: userWsxmrAta,
          lpWsxmrAta,
          pendingReturns: findPda([PENDING_RETURNS_SEED, user.publicKey.toBuffer()], programId)[0],
          vaultCollateralEscrow: vaultEscrow,
          collateralEscrow: programCollateralAta,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        }).signers([user]).rpc();

      const fee = (WSXMR_MINTED * 100n) / 10_000n; // 1% mint fee
      assert.equal(await tokenBal(userWsxmrAta), WSXMR_MINTED - fee);
      assert.equal(await tokenBal(lpWsxmrAta), fee);
      const v = await vaultState(vaultPda);
      assert.equal(v.normalizedDebt.toString(), WSXMR_MINTED.toString());
      assert.equal(v.pendingDebt.toString(), "0");
      assert.equal(v.lockedCollateral.toString(), "0");
    });
  });

  // ─── 5. Burn flow ──────────────────────────────────────────────────────────
  describe("5. Burn flow", () => {
    const BURN_WSXMR = 50_000_000n; // 0.5 wsXMR — under the 1.3x proportional lock
    let burnPda: PublicKey;
    let burnId: Buffer;
    let bSecret: ReturnType<typeof makeSecret>;
    let lpSecret: ReturnType<typeof makeSecret>;

    it("rejects a burn below the vault minimum", async () => {
      await program.methods.setMinBurnAmount(new BN("1000000")).accounts({
        lp: lp.publicKey, vault: vaultPda,
      }).signers([lp]).rpc();
      const s = makeSecret();
      const tiny = 500_000n;
      const nonce = (await globalReqNonce()) + 1n;
      const id = burnRequestId(user.publicKey, vaultPda, tiny, nonce);
      const pda = findPda([BURN_REQUEST_SEED, id], programId)[0];
      await expectReject(
        program.methods.requestBurn(
          new BN(tiny.toString()), Array.from(s.commitment),
          Array.from(s.pubKey), Array.from(s.pubKey), Array.from(id)
        ).accounts({
          user: user.publicKey, vault: vaultPda, globalState, burnRequest: pda,
          wsxmrMint, userWsxmrAta,
          tokenProgram: TOKEN_2022_PROGRAM_ID, systemProgram: SystemProgram.programId,
        }).signers([user]).rpc(),
        "BelowMinimumBurn"
      );
    });

    it("rejects a bad burn request_id", async () => {
      const s = makeSecret();
      const badId = crypto.randomBytes(32);
      const pda = findPda([BURN_REQUEST_SEED, badId], programId)[0];
      await expectReject(
        program.methods.requestBurn(
          new BN(BURN_WSXMR.toString()), Array.from(s.commitment),
          Array.from(s.pubKey), Array.from(s.pubKey), Array.from(badId)
        ).accounts({
          user: user.publicKey, vault: vaultPda, globalState, burnRequest: pda,
          wsxmrMint, userWsxmrAta,
          tokenProgram: TOKEN_2022_PROGRAM_ID, systemProgram: SystemProgram.programId,
        }).signers([user]).rpc(),
        "InvalidBurnRequest"
      );
    });

    it("user requests a burn — wsXMR burned, proportional collateral locked", async () => {
      const vBefore = await vaultState(vaultPda);
      const debt = BigInt(vBefore.normalizedDebt.toString());
      const free = BigInt(vBefore.collateralAmount.toString())
        - BigInt(vBefore.lockedCollateral.toString());
      bSecret = makeSecret();
      const nonce = (await globalReqNonce()) + 1n;
      burnId = burnRequestId(user.publicKey, vaultPda, BURN_WSXMR, nonce);
      burnPda = findPda([BURN_REQUEST_SEED, burnId], programId)[0];
      const userBalBefore = await tokenBal(userWsxmrAta);
      await program.methods.requestBurn(
        new BN(BURN_WSXMR.toString()), Array.from(bSecret.commitment),
        Array.from(bSecret.pubKey), Array.from(bSecret.pubKey), Array.from(burnId)
      ).accounts({
        user: user.publicKey, vault: vaultPda, globalState, burnRequest: burnPda,
        wsxmrMint, userWsxmrAta,
        tokenProgram: TOKEN_2022_PROGRAM_ID, systemProgram: SystemProgram.programId,
      }).signers([user]).rpc();
      assert.equal(await tokenBal(userWsxmrAta), userBalBefore - BURN_WSXMR);

      const req = await program.account.burnRequest.fetch(burnPda);
      const expectedBase = (free * BURN_WSXMR * BURN_LOCK_MULT_BPS) / debt / BPS_DENOMINATOR;
      const expectedReward = (par(BURN_WSXMR) * 50n) / 10_000n; // 0.5% reward
      assert.equal(req.lockedCollateral.toString(), expectedBase.toString());
      assert.equal(req.rewardCollateral.toString(), expectedReward.toString());
      assert.equal(req.thresholdAtRequest.toString(), THRESHOLD.toString());
    });

    it("rejects propose_hash from non-LP", async () => {
      const s = makeSecret();
      await expectReject(
        program.methods.proposeHash(
          Array.from(s.commitment), Array.from(s.pubKey), Array.from(s.pubKey)
        ).accounts({ lp: user.publicKey, vault: vaultPda, burnRequest: burnPda })
          .signers([user]).rpc()
      );
    });

    it("LP proposes secret hash", async () => {
      lpSecret = makeSecret();
      await program.methods.proposeHash(
        Array.from(lpSecret.commitment), Array.from(lpSecret.pubKey), Array.from(lpSecret.pubKey)
      ).accounts({ lp: lp.publicKey, vault: vaultPda, burnRequest: burnPda }).signers([lp]).rpc();
      const req = await program.account.burnRequest.fetch(burnPda);
      assert.isTrue('proposed' in req.status);
    });

    it("user confirms Monero lock", async () => {
      await program.methods.confirmMoneroLock().accounts({
        user: user.publicKey, burnRequest: burnPda,
      }).signers([user]).rpc();
      const req = await program.account.burnRequest.fetch(burnPda);
      assert.isTrue('committed' in req.status);
    });

    it("rejects finalize_burn with wrong secret", async () => {
      const wrong = crypto.randomBytes(32); wrong[31] &= 0x0f;
      await expectReject(
        program.methods.finalizeBurn(Array.from(wrong))
          .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })])
          .accounts({
            caller: lp.publicKey, vaultLp: lp.publicKey,
            vault: vaultPda, globalState, burnRequest: burnPda,
            userPendingReturns: findPda([PENDING_RETURNS_SEED, user.publicKey.toBuffer()], programId)[0],
            vaultCollateralEscrow: vaultEscrow,
            collateralEscrow: programCollateralAta,
            tokenProgram: TOKEN_2022_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          }).signers([lp]).rpc()
      );
    });

    it("LP finalizes burn — par reward credited to user pending returns", async () => {
      const reqBefore = await program.account.burnRequest.fetch(burnPda);
      const reward = BigInt(reqBefore.rewardCollateral.toString());
      await program.methods.finalizeBurn(Array.from(lpSecret.secret))
        .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })])
        .accounts({
          caller: lp.publicKey, vaultLp: lp.publicKey,
          vault: vaultPda, globalState, burnRequest: burnPda,
          userPendingReturns: findPda([PENDING_RETURNS_SEED, user.publicKey.toBuffer()], programId)[0],
          vaultCollateralEscrow: vaultEscrow,
          collateralEscrow: programCollateralAta,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        }).signers([lp]).rpc();

      const v = await vaultState(vaultPda);
      assert.equal(v.normalizedDebt.toString(), "50000000"); // 1.0 - 0.5 burned
      assert.equal(v.activeBurnCount, 0);
      const pr = await program.account.pendingReturns.fetch(
        findPda([PENDING_RETURNS_SEED, user.publicKey.toBuffer()], programId)[0]
      );
      assert.equal(pr.collateralAmount.toString(), reward.toString());
    });
  });

  // ─── 6. repay_debt ─────────────────────────────────────────────────────────
  describe("6. repay_debt", () => {
    it("LP burns wsXMR to retire vault debt", async () => {
      // Give the LP the fee wsXMR — it repays the remaining 0.5 debt.
      const fee = 1_000_000n;
      assert.equal(await tokenBal(lpWsxmrAta), fee);
      // Transfer 0.4 wsXMR from the user so the LP can repay in full.
      const needed = 50_000_000n - fee;
      const tx = new Transaction().add(
        createTransferInstruction(userWsxmrAta, lpWsxmrAta, user.publicKey, needed,
          [], TOKEN_2022_PROGRAM_ID)
      );
      await provider.sendAndConfirm(tx, [user]);

      await program.methods.repayDebt(new BN("50000000")).accounts({
        lp: lp.publicKey, vault: vaultPda, globalState,
        wsxmrMint, lpWsxmrAta,
        auction: null, bondEscrow: null, vaultCollateralEscrow: null,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      }).signers([lp]).rpc();
      const v = await vaultState(vaultPda);
      assert.equal(v.normalizedDebt.toString(), "0");
    });
  });

  // ─── 7. Auction lifecycle (vault2) ─────────────────────────────────────────
  describe("7. Auction lifecycle", () => {
    const VAULT2_COL = 3_500_000_000n; // 3.5 SOL
    const XMR_AMOUNT = 1_000_000_000_000n;
    const WSXMR_DEBT = 100_000_000n;   // 1 wsXMR

    it("sets up vault2 (lp2): threshold + collateral + debt", async () => {
      await program.methods.createVault().accounts({
        lp: lp2.publicKey, vault: vault2Pda, globalState,
        systemProgram: SystemProgram.programId,
      }).signers([lp2]).rpc();
      await program.methods.setThreshold(new BN(THRESHOLD.toString())).accounts({
        lp: lp2.publicKey, vault: vault2Pda,
      }).signers([lp2]).rpc();
      await program.methods.setMinterWhitelist(user.publicKey, true).accounts({
        lp: lp2.publicKey, vault: vault2Pda,
      }).signers([lp2]).rpc();
      await deposit(lp2, vault2Pda, vault2Escrow, VAULT2_COL);

      // Mint 1 wsXMR to the liquidator so they can bid.
      const { pda, uSecret } = await driveMintToReady(vault2Pda, lp2, liquidator.publicKey, XMR_AMOUNT);
      liquidatorWsxmrAta = await createAta(wsxmrMint, liquidator.publicKey);
      await program.methods.revealSecret(Array.from(uSecret.secret)).accounts({
        caller: user.publicKey, mintRequest: pda,
      }).signers([user]).rpc();
      await program.methods.finalizeMint()
        .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })])
        .accounts({
          caller: user.publicKey, vault: vault2Pda, globalState, mintRequest: pda,
          wsxmrMint,
          recipientWsxmrAta: liquidatorWsxmrAta,
          lpWsxmrAta: await createAta(wsxmrMint, lp2.publicKey),
          pendingReturns: findPda([PENDING_RETURNS_SEED, user.publicKey.toBuffer()], programId)[0],
          vaultCollateralEscrow: vault2Escrow,
          collateralEscrow: programCollateralAta,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        }).signers([user]).rpc();
      const v = await vaultState(vault2Pda);
      assert.equal(v.normalizedDebt.toString(), WSXMR_DEBT.toString());
    });

    it("permissionless kick — bond escrow funded, kick_active set", async () => {
      const bond = kickBond(VAULT2_COL);
      await program.methods.kick().accounts({
        kicker: keeper.publicKey,
        vault: vault2Pda,
        auction: auctionPdaOf(vault2Pda),
        bondEscrow: bondEscrowOf(vault2Pda),
        globalState,
        systemProgram: SystemProgram.programId,
      }).signers([keeper]).rpc();
      const v = await vaultState(vault2Pda);
      assert.isTrue(v.kickActive);
      const auc = await auctionState(vault2Pda);
      assert.equal(auc.bond.toString(), bond.toString());
      assert.equal(await lamports(bondEscrowOf(vault2Pda)), bond);
      assert.isTrue(auc.active);
    });

    it("kick blocks mint/burn/withdraw (vaultNotBlocked)", async () => {
      const s = makeSecret();
      const nonce = (await globalReqNonce()) + 1n;
      const id = mintRequestId(user.publicKey, vault2Pda, XMR_AMOUNT, s.commitment, nonce);
      const pda = findPda([MINT_REQUEST_SEED, id], programId)[0];
      await expectReject(
        program.methods.initiateMint(
          new BN(XMR_AMOUNT.toString()), Array.from(s.commitment),
          Array.from(s.pubKey), Array.from(id)
        ).accounts({
          initiator: user.publicKey, recipient: user.publicKey,
          vault: vault2Pda, globalState, mintRequest: pda,
          griefingEscrow: lp2.publicKey,
          initiatorPendingReturns: findPda([PENDING_RETURNS_SEED, user.publicKey.toBuffer()], programId)[0],
          systemProgram: SystemProgram.programId,
        }).signers([user]).rpc(),
        "KickActive"
      );
      await expectReject(
        program.methods.withdrawCollateral(new BN("1")).accounts({
          lp: lp2.publicKey, vault: vault2Pda, globalState,
          vaultCollateralEscrow: vault2Escrow,
          systemProgram: SystemProgram.programId,
        }).signers([lp2]).rpc(),
        "KickActive"
      );
    });

    it("LP deposit during GRACE cancels the kick — bond → vault equity", async () => {
      const vBefore = await vaultState(vault2Pda);
      const bond = BigInt((await auctionState(vault2Pda)).bond.toString());
      await deposit(lp2, vault2Pda, vault2Escrow, 100_000_000n);
      const v = await vaultState(vault2Pda);
      assert.isFalse(v.kickActive);
      assert.equal(
        BigInt(v.collateralAmount.toString()),
        BigInt(vBefore.collateralAmount.toString()) + 100_000_000n + bond
      );
      const auc = await auctionState(vault2Pda);
      assert.isFalse(auc.active);
    });

    it("rejects re-kick during the cooldown", async () => {
      await expectReject(
        program.methods.kick().accounts({
          kicker: keeper.publicKey, vault: vault2Pda,
          auction: auctionPdaOf(vault2Pda), bondEscrow: bondEscrowOf(vault2Pda),
          globalState, systemProgram: SystemProgram.programId,
        }).signers([keeper]).rpc(),
        "KickOnCooldown"
      );
    });

    it("re-kick after cooldown → open_auction after grace+delay", async () => {
      await sleep((KICK_COOLDOWN_S + 2) * 1000);
      await program.methods.kick().accounts({
        kicker: keeper.publicKey, vault: vault2Pda,
        auction: auctionPdaOf(vault2Pda), bondEscrow: bondEscrowOf(vault2Pda),
        globalState, systemProgram: SystemProgram.programId,
      }).signers([keeper]).rpc();

      // open_auction too early → BidNotOpen
      await expectReject(
        program.methods.openAuction().accounts({
          caller: keeper.publicKey, vault: vault2Pda,
          auction: auctionPdaOf(vault2Pda),
        }).signers([keeper]).rpc(),
        "BidNotOpen"
      );

      await sleep((KICK_GRACE_S + OPEN_DELAY_S + 3) * 1000);
      await program.methods.openAuction().accounts({
        caller: keeper.publicKey, vault: vault2Pda,
        auction: auctionPdaOf(vault2Pda),
      }).signers([keeper]).rpc();
      const auc = await auctionState(vault2Pda);
      assert.isTrue(auc.auctionOpened);
      const v = await vaultState(vault2Pda);
      assert.equal(auc.offeredCollateral.toString(),
        (BigInt(v.collateralAmount.toString()) - BigInt(v.lockedCollateral.toString())).toString());
      assert.equal(v.liquidationNonce, 1);
      assert.equal(v.mintNonce, 1);
    });

    it("bid — liquidator burns the full debt for X(t)% of offered collateral", async () => {
      const vBefore = await vaultState(vault2Pda);
      const auc = await auctionState(vault2Pda);
      const offered = BigInt(auc.offeredCollateral.toString());
      const escrowBefore = await lamports(vault2Escrow);
      const keeperBefore = await lamports(keeper.publicKey);
      const liqBefore = await lamports(liquidator.publicKey);

      await program.methods.bid()
        .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })])
        .accounts({
          bidder: liquidator.publicKey,
          vault: vault2Pda,
          auction: auctionPdaOf(vault2Pda),
          kicker: keeper.publicKey,
          bondEscrow: bondEscrowOf(vault2Pda),
          globalState,
          wsxmrMint,
          bidderWsxmrAta: liquidatorWsxmrAta,
          vaultCollateralEscrow: vault2Escrow,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        }).signers([liquidator]).rpc();

      const v = await vaultState(vault2Pda);
      assert.equal(v.normalizedDebt.toString(), "0");
      assert.isFalse(v.kickActive);
      const aucAfter = await auctionState(vault2Pda);
      assert.isFalse(aucAfter.active);

      // Liquidator paid the full debt in wsXMR.
      assert.equal(await tokenBal(liquidatorWsxmrAta), 0n);

      // Escrow paid out payout + chip; kicker received bond + chip back
      // (X* > 80% at this early bid → sane kick). The liquidator's lamport gain
      // is net of tx fees, so compare with tolerance.
      const escrowSpent = escrowBefore - await lamports(vault2Escrow);
      const keeperGain = await lamports(keeper.publicKey) - keeperBefore;
      const liqGain = await lamports(liquidator.publicKey) - liqBefore;
      const bond = BigInt(auc.bond.toString());
      assert.isAbove(Number(escrowSpent), 0);
      assert.isAbove(Number(keeperGain), Number(bond));
      assert.isAbove(Number(liqGain), 0);
      const gap = escrowSpent - (liqGain + keeperGain - bond);
      assert.isBelow(Math.abs(Number(gap)), 50_000, "escrow outflow != payouts");
    });
  });

  // ─── 8. Auction expiry → freeze → backstop (vault3) ───────────────────────
  describe("8. Auction expiry → backstop", () => {
    const VAULT3_COL = 3_500_000_000n;
    const XMR_AMOUNT = 1_000_000_000_000n;
    const BURN_WSXMR = 30_000_000n;
    let vault3BurnPda: PublicKey;

    it("sets up vault3 (lp3) with debt and an in-flight burn", async () => {
      await program.methods.createVault().accounts({
        lp: lp3.publicKey, vault: vault3Pda, globalState,
        systemProgram: SystemProgram.programId,
      }).signers([lp3]).rpc();
      await program.methods.setThreshold(new BN(THRESHOLD.toString())).accounts({
        lp: lp3.publicKey, vault: vault3Pda,
      }).signers([lp3]).rpc();
      await program.methods.setMinterWhitelist(user.publicKey, true).accounts({
        lp: lp3.publicKey, vault: vault3Pda,
      }).signers([lp3]).rpc();
      await deposit(lp3, vault3Pda, vault3Escrow, VAULT3_COL);

      // Mint 1 wsXMR to the user — creates vault3 debt.
      const { pda, uSecret } = await driveMintToReady(vault3Pda, lp3, user.publicKey, XMR_AMOUNT);
      await program.methods.revealSecret(Array.from(uSecret.secret)).accounts({
        caller: user.publicKey, mintRequest: pda,
      }).signers([user]).rpc();
      lp3WsxmrAta = await createAta(wsxmrMint, lp3.publicKey);
      await program.methods.finalizeMint()
        .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })])
        .accounts({
          caller: user.publicKey, vault: vault3Pda, globalState, mintRequest: pda,
          wsxmrMint,
          recipientWsxmrAta: userWsxmrAta,
          lpWsxmrAta: lp3WsxmrAta,
          pendingReturns: findPda([PENDING_RETURNS_SEED, user.publicKey.toBuffer()], programId)[0],
          vaultCollateralEscrow: vault3Escrow,
          collateralEscrow: programCollateralAta,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        }).signers([user]).rpc();

      // In-flight REQUESTED burn — still Requested when the kick lands.
      const s = makeSecret();
      const nonce = (await globalReqNonce()) + 1n;
      const id = burnRequestId(user.publicKey, vault3Pda, BURN_WSXMR, nonce);
      const burnPda = findPda([BURN_REQUEST_SEED, id], programId)[0];
      await program.methods.requestBurn(
        new BN(BURN_WSXMR.toString()), Array.from(s.commitment),
        Array.from(s.pubKey), Array.from(s.pubKey), Array.from(id)
      ).accounts({
        user: user.publicKey, vault: vault3Pda, globalState, burnRequest: burnPda,
        wsxmrMint, userWsxmrAta,
        tokenProgram: TOKEN_2022_PROGRAM_ID, systemProgram: SystemProgram.programId,
      }).signers([user]).rpc();
      vault3BurnPda = burnPda;
    });

    it("kick vault3 → wait through grace+delay → resolve the in-flight burn", async function () {
      await program.methods.kick().accounts({
        kicker: keeper.publicKey, vault: vault3Pda,
        auction: auctionPdaOf(vault3Pda), bondEscrow: bondEscrowOf(vault3Pda),
        globalState, systemProgram: SystemProgram.programId,
      }).signers([keeper]).rpc();

      await sleep((KICK_GRACE_S + 2) * 1000);

      const balBefore = await tokenBal(userWsxmrAta);
      const burnPda = vault3BurnPda;
      await program.methods.resolveBurnForAuction().accounts({
        caller: keeper.publicKey,
        vault: vault3Pda,
        auction: auctionPdaOf(vault3Pda),
        globalState,
        burnRequest: burnPda,
        userPendingReturns: findPda([PENDING_RETURNS_SEED, user.publicKey.toBuffer()], programId)[0],
        wsxmrMint, userWsxmrAta,
        vaultCollateralEscrow: vault3Escrow,
        collateralEscrow: programCollateralAta,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      }).signers([keeper]).rpc();
      // REQUESTED burn re-minted the wsXMR back to the user.
      assert.equal(await tokenBal(userWsxmrAta), balBefore + BURN_WSXMR);
      const v = await vaultState(vault3Pda);
      assert.equal(v.activeBurnCount, 0);
    });

    it("open_auction, then let it lapse to ENDED → resolve_kick freezes", async function () {
      this.timeout(120_000);
      await sleep((OPEN_DELAY_S + 3) * 1000);
      await program.methods.openAuction().accounts({
        caller: keeper.publicKey, vault: vault3Pda,
        auction: auctionPdaOf(vault3Pda),
      }).signers([keeper]).rpc();

      // bid too late is impossible here — just wait out the auction window.
      await sleep((AUCTION_DURATION_S + 5) * 1000);

      const kickerBefore = await lamports(keeper.publicKey);
      const bond = BigInt((await auctionState(vault3Pda)).bond.toString());
      await program.methods.resolveKick().accounts({
        caller: keeper.publicKey,
        vault: vault3Pda,
        auction: auctionPdaOf(vault3Pda),
        kicker: keeper.publicKey,
        bondEscrow: bondEscrowOf(vault3Pda),
        vaultCollateralEscrow: vault3Escrow,
        globalState,
        systemProgram: SystemProgram.programId,
      }).signers([keeper]).rpc();
      const v = await vaultState(vault3Pda);
      assert.isTrue(v.frozen);
      assert.isFalse(v.kickActive);
      assert.equal(await lamports(keeper.publicKey) - kickerBefore, bond);
    });

    it("frozen vault blocks withdraw and config", async () => {
      await expectReject(
        program.methods.withdrawCollateral(new BN("1")).accounts({
          lp: lp3.publicKey, vault: vault3Pda, globalState,
          vaultCollateralEscrow: vault3Escrow,
          systemProgram: SystemProgram.programId,
        }).signers([lp3]).rpc(),
        "VaultFrozen"
      );
    });

    it("backstop_vault — healthy LP assumes the frozen vault's debt + collateral", async () => {
      const oldDebt = 100_000_000n;
      const oldCol = BigInt((await vaultState(vault3Pda)).collateralAmount.toString());
      const lpBefore = await vaultState(vaultPda);
      await program.methods.backstopVault().accounts({
        newLp: lp.publicKey,
        oldVault: vault3Pda,
        newVault: vaultPda,
        auction: null, kicker: null, bondEscrow: null,
        globalState,
        oldVaultCollateralEscrow: vault3Escrow,
        newVaultCollateralEscrow: vaultEscrow,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      }).signers([lp]).rpc();

      const old = await vaultState(vault3Pda);
      assert.equal(old.normalizedDebt.toString(), "0");
      assert.equal(old.collateralAmount.toString(), "0");
      assert.isFalse(old.frozen);
      const nu = await vaultState(vaultPda);
      assert.equal(
        BigInt(nu.normalizedDebt.toString()),
        BigInt(lpBefore.normalizedDebt.toString()) + oldDebt
      );
      assert.equal(
        BigInt(nu.collateralAmount.toString()),
        BigInt(lpBefore.collateralAmount.toString()) + oldCol
      );
    });
  });

  // ─── 9. Withdrawals + reconciliation ───────────────────────────────────────
  describe("9. Withdrawals", () => {
    it("user withdraws pending collateral — drains from program pool", async () => {
      const [prPda] = findPda([PENDING_RETURNS_SEED, user.publicKey.toBuffer()], programId);
      const pr = await program.account.pendingReturns.fetch(prPda);
      const credit = BigInt(pr.collateralAmount.toString());
      assert.isAbove(Number(credit), 0);
      const before = await lamports(user.publicKey);
      await program.methods.withdrawCollateralReturns().accounts({
        owner: user.publicKey, pendingReturns: prPda,
        globalState, collateralEscrow: programCollateralAta,
        systemProgram: SystemProgram.programId,
      }).signers([user]).rpc();
      assert.equal(await lamports(user.publicKey) - before, credit);
      const prAfter = await program.account.pendingReturns.fetch(prPda);
      assert.equal(prAfter.collateralAmount.toString(), "0");
    });

    it("rejects withdraw_collateral_returns when balance is zero", async () => {
      const [prPda] = findPda([PENDING_RETURNS_SEED, user.publicKey.toBuffer()], programId);
      await expectReject(
        program.methods.withdrawCollateralReturns().accounts({
          owner: user.publicKey, pendingReturns: prPda,
          globalState, collateralEscrow: programCollateralAta,
          systemProgram: SystemProgram.programId,
        }).signers([user]).rpc()
      );
    });
  });

  describe("10. Reconciliation", () => {
    it("reconcile_global_debt is a no-op without drift", async () => {
      await program.methods.reconcileGlobalDebt().accounts({
        authority: admin.publicKey, globalState,
      }).rpc();
      const gs = await program.account.globalState.fetch(globalState);
      assert.isOk(gs.globalTotalDebt.toNumber() >= 0);
    });
  });
});
