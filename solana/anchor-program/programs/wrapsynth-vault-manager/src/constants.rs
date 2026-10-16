/// Protocol constants — native-SOL-collateral variant (no yield, no protocol fees).

// Collateral ratios (percentage, precision 100) — retuned for VOLATILE
// collateral: both legs move (XMR vs SOL), so margins are wider than the
// stable-collateral sUSDe deployment.
pub const COLLATERAL_RATIO: u64 = 200; // mint floor
pub const LIQUIDATION_RATIO: u64 = 150; // liquidate below this
pub const LIQUIDATION_BONUS: u64 = 110; // liquidator incentive (gross, pre-split)
pub const RATIO_PRECISION: u64 = 100;
pub const BURN_LOCK_RATIO: u64 = 160; // reserve for in-flight burns
pub const MINT_LOCK_RATIO: u64 = 160; // key bond / par lock buffer over par

// Compile-time invariant checks — these must hold or the program fails to compile.
// Ordering: LIQUIDATION_RATIO < COLLATERAL_RATIO. BURN_LOCK_RATIO sits above
// LIQUIDATION_RATIO so in-flight burn reservations survive the liquidation band.
const _: () = assert!(
    LIQUIDATION_RATIO < COLLATERAL_RATIO,
    "LIQUIDATION_RATIO must be < COLLATERAL_RATIO"
);
const _: () = assert!(
    BURN_LOCK_RATIO >= LIQUIDATION_RATIO,
    "BURN_LOCK_RATIO must cover the liquidation band"
);
const _: () = assert!(
    MINT_LOCK_RATIO >= RATIO_PRECISION,
    "MINT_LOCK_RATIO must be >= 100%"
);

// Precision constants
pub const PRICE_PRECISION: u64 = 1_000_000_000_000_000_000; // 1e18
pub const WSXMR_DECIMALS: u64 = 100_000_000; // 1e8
/// Native SOL collateral decimals scale (9 decimals — raw lamports).
/// collateral_amount / locked_collateral are stored in raw lamports so
/// vault bookkeeping equals the vault collateral escrow balance exactly.
pub const COLLATERAL_DECIMALS: u64 = 1_000_000_000; // 1e9
pub const DEBT_INDEX_PRECISION: u64 = 1_000_000_000_000_000_000; // 1e18
pub const XMR_TO_WSXMR_DIVISOR: u64 = 10_000; // 1e4 (12 dec → 8 dec)

// Timeouts (seconds)
pub const LP_CLAIM_WINDOW: i64 = 1_800; // 30 min for LP to claim after mint expiry
pub const MINT_READY_EXTENSION: i64 = 7_200; // 2 hours
pub const BURN_COMMIT_TIMEOUT: i64 = 7_200; // 2 hours
pub const BURN_FINALIZE_GRACE: i64 = 600; // 10 min grace for LP finalization
pub const GRACE_PERIOD: i64 = 900; // 15 minutes

// Per-vault timeout configuration (EVM MIN/MAX/DEFAULT_*_TIMEOUT_BLOCKS parity)
pub const MIN_MINT_TIMEOUT_SECONDS: i64 = 1_800; // ~30 min
pub const MAX_MINT_TIMEOUT_SECONDS: i64 = 86_400; // ~24 hours
pub const DEFAULT_MINT_TIMEOUT_SECONDS: i64 = 3_600; // ~1 hour
pub const MIN_BURN_TIMEOUT_SECONDS: i64 = 1_800; // ~30 min
pub const MAX_BURN_TIMEOUT_SECONDS: i64 = 86_400; // ~24 hours
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

// Oracle staleness
pub const PRICE_MAX_AGE: u64 = 120; // 2 minutes
pub const LIQUIDITY_PRICE_MAX_AGE: u64 = 30; // 30 seconds

// Pyth feed IDs
pub const XMR_USD_FEED_ID: [u8; 32] = [
    0x46, 0xb8, 0xcc, 0x93, 0x47, 0xf0, 0x43, 0x91, 0x76, 0x4a, 0x03, 0x61, 0xe0, 0xb1, 0x7c, 0x3b,
    0xa3, 0x94, 0xb0, 0x01, 0xe7, 0xc3, 0x04, 0xf7, 0x65, 0x0f, 0x63, 0x76, 0xe3, 0x7c, 0x32, 0x1d,
];

// SOL/USD Pyth feed ID (Crypto.SOL/USD — 24/7 publishing)
pub const SOL_USD_FEED_ID: [u8; 32] = [
    0xef, 0x0d, 0x8b, 0x6f, 0xda, 0x2c, 0xeb, 0xa4, 0x1d, 0xa1, 0x5d, 0x40, 0x95, 0xd1, 0xda, 0x39,
    0x2a, 0x0d, 0x2f, 0x8e, 0xd0, 0xc6, 0xc7, 0xbc, 0x0f, 0x4c, 0xfa, 0xc8, 0xc2, 0x80, 0xb5, 0x6d,
];

// Discount guard tolerance: pause minting if market SOL/USD falls sharply
// below its own EMA (flash-crash / oracle anomaly guard).
pub const DEPEG_TOLERANCE_BPS: u64 = 300; // 3%

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
