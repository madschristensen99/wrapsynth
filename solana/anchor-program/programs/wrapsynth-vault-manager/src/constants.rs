/// Protocol constants — oracle-free variant.
///
/// No external price feeds exist in consensus. LP-declared per-vault
/// thresholds (lamports of SOL collateral per 1e8 wsXMR) define par
/// settlement, mint capacity, and coverage. Liquidation is market-discovered
/// via the bonded-kick Dutch haircut auction.

// Precision constants
pub const WSXMR_DECIMALS: u64 = 100_000_000; // 1e8
/// Native SOL collateral decimals scale (9 decimals — raw lamports).
/// collateral_amount / locked_collateral are stored in raw lamports so
/// vault bookkeeping equals the vault collateral escrow balance exactly.
pub const COLLATERAL_DECIMALS: u64 = 1_000_000_000; // 1e9
pub const DEBT_INDEX_PRECISION: u64 = 1_000_000_000_000_000_000; // 1e18
pub const XMR_TO_WSXMR_DIVISOR: u64 = 10_000; // 1e4 (12 dec → 8 dec)
pub const RATIO_PRECISION: u64 = 100;

// Lock ratios (EVM wsXmrStorage parity)
pub const MINT_LOCK_RATIO: u64 = 110; // key bond / par lock = 110% of par collateral
pub const BURN_LOCK_MULTIPLIER_BPS: u64 = 13_000; // 1.3× proportional burn lock

// Threshold floor — LPs declare thresholds in lamports per 1e8 wsXMR.
// A vault whose threshold sits below this floor cannot mint (capacity = 0).
// 0.01 SOL per wsXMR — the floor exists to catch fat-fingered zero/near-zero
// declarations, not to police real quotes.
pub const MIN_THRESHOLD_LAMPORTS: u128 = 10_000_000;

// ─── Kick auction (docs/ORACLE_FREE_MIGRATION_SPEC.md §2.2 — EVM parity) ────
// Times are unix seconds (EVM used ~1s/block; identical wall-clock values).
// The `test-lifecycle` cargo feature shrinks the wall-clock windows so the
// localnet suite can drive a full kick→auction→resolve lifecycle — build the
// test validator's program with `cargo build-sbf --features test-lifecycle`.
#[cfg(feature = "test-lifecycle")]
pub const KICK_GRACE_SECONDS: i64 = 15;
#[cfg(not(feature = "test-lifecycle"))]
pub const KICK_GRACE_SECONDS: i64 = 3_600; // ~1h LP respond window
#[cfg(feature = "test-lifecycle")]
pub const KICK_COOLDOWN_SECONDS: i64 = 10;
#[cfg(not(feature = "test-lifecycle"))]
pub const KICK_COOLDOWN_SECONDS: i64 = 21_600; // ~6h per-vault re-kick rate limit
#[cfg(feature = "test-lifecycle")]
pub const AUCTION_DURATION_SECONDS: i64 = 60;
#[cfg(not(feature = "test-lifecycle"))]
pub const AUCTION_DURATION_SECONDS: i64 = 86_400; // ~24h Dutch window
#[cfg(feature = "test-lifecycle")]
pub const AUCTION_OPEN_DELAY_SECONDS: i64 = 10;
#[cfg(not(feature = "test-lifecycle"))]
pub const AUCTION_OPEN_DELAY_SECONDS: i64 = 1_800; // ~30min LP rescue window
pub const KICK_BOND_BPS: u64 = 200; // 2% of vault collateral
pub const KICK_BOND_MIN_LAMPORTS: u64 = 50_000_000; // 0.05 SOL floor
pub const HAIRCUT_START_BPS: u64 = 10_000; // offer opens at 100% of collateral
pub const HAIRCUT_FLOOR_BPS: u64 = 500; // 5% — curve end; below → inconclusive
pub const CHIP_BPS: u64 = 50; // kicker's cut of liquidation surplus
pub const KICK_SANE_BPS: u64 = 8_000; // wrongful-kick threshold: clearing X* ≤ 80%

// Timeouts (seconds)
#[cfg(feature = "test-lifecycle")]
pub const LP_CLAIM_WINDOW: i64 = 20;
#[cfg(not(feature = "test-lifecycle"))]
pub const LP_CLAIM_WINDOW: i64 = 1_800; // 30 min for LP to claim after mint expiry
pub const MINT_READY_EXTENSION: i64 = 7_200; // 2 hours
pub const BURN_COMMIT_TIMEOUT: i64 = 7_200; // 2 hours
#[cfg(feature = "test-lifecycle")]
pub const BURN_FINALIZE_GRACE: i64 = 10;
#[cfg(not(feature = "test-lifecycle"))]
pub const BURN_FINALIZE_GRACE: i64 = 600; // 10 min grace for LP finalization
#[cfg(feature = "test-lifecycle")]
pub const GRACE_PERIOD: i64 = 10;
#[cfg(not(feature = "test-lifecycle"))]
pub const GRACE_PERIOD: i64 = 900; // 15 minutes

// Per-vault timeout configuration (EVM MIN/MAX/DEFAULT_*_TIMEOUT_BLOCKS parity)
#[cfg(feature = "test-lifecycle")]
pub const MIN_MINT_TIMEOUT_SECONDS: i64 = 10;
#[cfg(not(feature = "test-lifecycle"))]
pub const MIN_MINT_TIMEOUT_SECONDS: i64 = 1_800; // ~30 min
pub const MAX_MINT_TIMEOUT_SECONDS: i64 = 86_400; // ~24 hours
#[cfg(feature = "test-lifecycle")]
pub const DEFAULT_MINT_TIMEOUT_SECONDS: i64 = 30;
#[cfg(not(feature = "test-lifecycle"))]
pub const DEFAULT_MINT_TIMEOUT_SECONDS: i64 = 3_600; // ~1 hour
#[cfg(feature = "test-lifecycle")]
pub const MIN_BURN_TIMEOUT_SECONDS: i64 = 10;
#[cfg(not(feature = "test-lifecycle"))]
pub const MIN_BURN_TIMEOUT_SECONDS: i64 = 1_800; // ~30 min
pub const MAX_BURN_TIMEOUT_SECONDS: i64 = 86_400; // ~24 hours
#[cfg(feature = "test-lifecycle")]
pub const DEFAULT_BURN_TIMEOUT_SECONDS: i64 = 30;
#[cfg(not(feature = "test-lifecycle"))]
pub const DEFAULT_BURN_TIMEOUT_SECONDS: i64 = 3_600; // ~1 hour

// Minter whitelist (EVM whitelistedMinters parity — fixed-size cap for Solana)
pub const MAX_WHITELISTED_MINTERS: usize = 32;

// Co-LP (Orca Whirlpools) — EVM co-LP constants parity
pub const MIN_CO_LP_RANGE_BPS: u16 = 1_000;
pub const MAX_CO_LP_RANGE_BPS: u16 = 10_000;
pub const DEFAULT_CO_LP_RANGE_BPS: u16 = 2_500;
pub const CO_LP_REBALANCE_FEE_BPS: u64 = 10; // 0.1% keeper fee on rebalance
pub const ORCA_WHIRLPOOLS_PROGRAM_ID: &str = "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc";

// Fee caps
pub const BPS_DENOMINATOR: u64 = 10_000;
pub const MAX_MARGIN_BPS: u64 = 1_000; // 10%

// Protocol limits
pub const MIN_BURN_AMOUNT: u64 = 1_000_000; // 0.01 wsXMR (8 decimals)
pub const MAX_BURN_REQUESTS_PER_VAULT: u32 = 50;
pub const INITIAL_DEBT_INDEX: u64 = 1_000_000_000_000_000_000; // 1e18

// Wrapped SOL mint — the SPL representation of the native collateral used by
// co-LP whirlpool positions (Orca pools pair tokens, so SOL deploys as wSOL).
pub const WSOL_MINT: &str = "So11111111111111111111111111111111111111112";

// PDA seeds
pub const GLOBAL_STATE_SEED: &[u8] = b"global_state";
pub const VAULT_SEED: &[u8] = b"vault";
pub const MINT_REQUEST_SEED: &[u8] = b"mint_request";
pub const BURN_REQUEST_SEED: &[u8] = b"burn_request";
pub const PENDING_RETURNS_SEED: &[u8] = b"pending_returns";
pub const WSXMR_MINT_SEED: &[u8] = b"wsxmr_mint";
pub const VAULT_COLLATERAL_SEED: &[u8] = b"vault_collateral";
pub const CO_LP_POSITION_SEED: &[u8] = b"co_lp_position";
pub const CO_LP_POSITION_MINT_SEED: &[u8] = b"co_lp_position_mint";
/// Program-owned collateral escrow (lamport PDA) — the pending collateral
/// returns pool backing all slashed-collateral credits
/// (invariant: balance >= global_pending_collateral).
pub const PROGRAM_COLLATERAL_SEED: &[u8] = b"program_collateral";
/// One auction record per vault — created by kick(), reused across kicks.
pub const AUCTION_SEED: &[u8] = b"auction";
/// Per-vault lamport PDA holding the active kicker's bond.
pub const AUCTION_BOND_SEED: &[u8] = b"auction_bond";
