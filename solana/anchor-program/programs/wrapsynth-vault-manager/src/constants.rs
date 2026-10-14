/// Protocol constants — QQQx-collateral variant (no yield, no protocol fees).

// Collateral ratios (percentage, precision 100) — retuned for VOLATILE
// collateral: both legs now move (XMR vs Nasdaq-100), so margins are wider
// than the stable-collateral sUSDe deployment.
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
/// QQQx collateral decimals scale (8 decimals — raw atomic units).
/// collateral_amount / locked_collateral are stored in raw atomic QQQx so
/// vault bookkeeping equals the vault ATA balance exactly.
pub const COLLATERAL_DECIMALS: u64 = 100_000_000; // 1e8
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

// QQQx/USD Pyth feed ID (Crypto.QQQX/USD — 24/7 publishing, verified 2026-10-14)
pub const QQQX_USD_FEED_ID: [u8; 32] = [
    0x17, 0x8a, 0x6f, 0x73, 0xa5, 0xae, 0xde, 0x9d, 0x0d, 0x68, 0x2e, 0x86, 0xb0, 0x04, 0x7c, 0x9f,
    0x33, 0x3e, 0xd0, 0xef, 0xe5, 0xc6, 0x53, 0x7c, 0xa9, 0x37, 0x56, 0x52, 0x19, 0xc4, 0x05, 0x4d,
];

// (Reserved for future use: Pyth also publishes Crypto.QQQX/QQQ.RR, the
// redemption-rate feed id 5fe0ad9f…38c7ca, if a NAV-based guard is wanted.)

// Discount guard tolerance: pause minting if market QQQX/USD < QQQ fair value
// × (10000 - tolerance) / 10000 (QQQx trading at a steep discount = distress).
pub const DEPEG_TOLERANCE_BPS: u64 = 300; // 3%

// QQQx mainnet mint (Backed Assets Nasdaq xStock, verified 2026-10-14).
// Token-2022, 8 decimals. NOTE: the mint carries permanentDelegate, pausable
// and freeze extensions — the issuer (Backed) can freeze/claw back collateral.
// This is accepted issuer risk for this deployment.
pub const QQQX_MINT: &str = "Xs8S1uUs1zvS2p7iwtsG3b6fkhpvmwz4GYU3gWAmWHZ";

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
/// Program-owned collateral ATA — the pending collateral returns pool backing
/// all slashed-collateral credits (invariant: balance >= global_pending_collateral).
pub const PROGRAM_COLLATERAL_SEED: &[u8] = b"program_collateral";
