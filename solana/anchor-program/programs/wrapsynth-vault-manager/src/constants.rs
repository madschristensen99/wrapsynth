/// Protocol constants — direct port from VaultManager.sol

// Collateral ratios (percentage, precision 100) — EVM parity values for stable
// collateral (sUSDe ≈ sDAI): only the XMR leg moves.
pub const COLLATERAL_RATIO: u64 = 150;      // mint floor (EVM parity)
pub const LIQUIDATION_RATIO: u64 = 120;     // liquidate below this (EVM parity)
pub const LIQUIDATION_BONUS: u64 = 110;     // liquidator incentive (EVM parity)
pub const RATIO_PRECISION: u64 = 100;
pub const BURN_LOCK_RATIO: u64 = 110;       // reserve for in-flight burns (EVM parity)
pub const YIELD_BUFFER_RATIO: u64 = 160;    // CR + 10 headroom after yield extraction
pub const MINT_LOCK_RATIO: u64 = 110;       // key bond / par lock buffer over par (EVM parity)

// Compile-time invariant checks — these must hold or the program fails to compile.
// Ordering: LIQUIDATION_RATIO < COLLATERAL_RATIO < YIELD_BUFFER_RATIO
// Note: BURN_LOCK_RATIO (110) sits BELOW LIQUIDATION_RATIO (120) — same as the EVM,
// where the burn lock is a buffer over par for the handshake window, not a solvency floor.
const _: () = assert!(LIQUIDATION_RATIO < COLLATERAL_RATIO,
    "LIQUIDATION_RATIO must be < COLLATERAL_RATIO");
const _: () = assert!(COLLATERAL_RATIO < YIELD_BUFFER_RATIO,
    "COLLATERAL_RATIO must be < YIELD_BUFFER_RATIO");
const _: () = assert!(BURN_LOCK_RATIO <= COLLATERAL_RATIO + 10,
    "BURN_LOCK_RATIO must not exceed COLLATERAL_RATIO + 10");

// Precision constants
pub const PRICE_PRECISION: u64 = 1_000_000_000_000_000_000; // 1e18
pub const WSXMR_DECIMALS: u64 = 100_000_000;                 // 1e8
pub const DEBT_INDEX_PRECISION: u64 = 1_000_000_000_000_000_000; // 1e18
pub const XMR_TO_WSXMR_DIVISOR: u64 = 10_000;               // 1e4 (12 dec → 8 dec)

// Timeouts (seconds)
pub const LP_CLAIM_WINDOW: i64 = 1_800;     // 30 min for LP to claim after mint expiry
pub const MINT_READY_EXTENSION: i64 = 7_200; // 2 hours
pub const BURN_COMMIT_TIMEOUT: i64 = 7_200;  // 2 hours
pub const BURN_FINALIZE_GRACE: i64 = 600;    // 10 min grace for LP finalization
pub const GRACE_PERIOD: i64 = 900;           // 15 minutes

// Per-vault timeout configuration (EVM MIN/MAX/DEFAULT_*_TIMEOUT_BLOCKS parity)
pub const MIN_MINT_TIMEOUT_SECONDS: i64 = 1_800;    // ~30 min
pub const MAX_MINT_TIMEOUT_SECONDS: i64 = 86_400;   // ~24 hours
pub const DEFAULT_MINT_TIMEOUT_SECONDS: i64 = 3_600; // ~1 hour
pub const MIN_BURN_TIMEOUT_SECONDS: i64 = 1_800;    // ~30 min
pub const MAX_BURN_TIMEOUT_SECONDS: i64 = 86_400;   // ~24 hours
pub const DEFAULT_BURN_TIMEOUT_SECONDS: i64 = 3_600; // ~1 hour

// Minter whitelist (EVM whitelistedMinters parity — fixed-size cap for Solana)
pub const MAX_WHITELISTED_MINTERS: usize = 32;

// Co-LP (Orca Whirlpools) — EVM co-LP constants parity
pub const MIN_CO_LP_RANGE_BPS: u16 = 1_000;
pub const MAX_CO_LP_RANGE_BPS: u16 = 10_000;
pub const DEFAULT_CO_LP_RANGE_BPS: u16 = 2_500;
pub const CO_LP_REBALANCE_FEE_BPS: u64 = 10; // 0.1% keeper fee on rebalance
pub const ORCA_WHIRLPOOLS_PROGRAM_ID: &str = "whirLbMiicVdio4qv2fSf1YjRUUPXusSbq2vMZmZ2A";

// Fee caps
pub const BPS_DENOMINATOR: u64 = 10_000;
pub const MAX_MARGIN_BPS: u64 = 1_000; // 10%

// Buy-and-burn
pub const COOLDOWN_PERIOD: i64 = 86_400;    // 24 hours
pub const BUY_CHUNK_PERCENT: u64 = 20;      // 20% of war chest per execution
pub const EMA_TRIGGER_THRESHOLD: u64 = 99;  // spot <= ema * 99/100
pub const KEEPER_REWARD_BPS: u64 = 200;     // 2%
pub const MEV_SLIPPAGE_BPS: u64 = 200;      // 2% max slippage

// Protocol limits
pub const MIN_BURN_AMOUNT: u64 = 1_000_000; // 0.01 wsXMR (8 decimals)
pub const MAX_BURN_REQUESTS_PER_VAULT: u32 = 50;
/// Fixed-size vault list cap (EVM MAX_VAULT_COUNT is 10000; Solana caps at 128
/// to keep GlobalState within account size limits)
pub const MAX_VAULTS: usize = 128;
pub const INITIAL_DEBT_INDEX: u64 = 1_000_000_000_000_000_000; // 1e18
pub const DEBT_DUST_THRESHOLD: u64 = 10_000;
pub const MIN_DEBT_INDEX: u64 = 10_000_000_000; // 1e10

// Oracle staleness
pub const PRICE_MAX_AGE: u64 = 120;          // 2 minutes
pub const LIQUIDITY_PRICE_MAX_AGE: u64 = 30; // 30 seconds

// Pyth feed IDs
pub const XMR_USD_FEED_ID: [u8; 32] = [
    0x46, 0xb8, 0xcc, 0x93, 0x47, 0xf0, 0x43, 0x91,
    0x76, 0x4a, 0x03, 0x61, 0xe0, 0xb1, 0x7c, 0x3b,
    0xa3, 0x94, 0xb0, 0x01, 0xe7, 0xc3, 0x04, 0xf7,
    0x65, 0x0f, 0x63, 0x76, 0xe3, 0x7c, 0x32, 0x1d,
];

// sUSDe/USD Pyth feed ID (Ethena staked USDe on Solana, verified 2026-10-12)
pub const SUSDE_USD_FEED_ID: [u8; 32] = [
    0xca, 0x3b, 0xa9, 0xa6, 0x19, 0xa4, 0xb3, 0x75,
    0x5c, 0x10, 0xac, 0x7d, 0x5e, 0x76, 0x02, 0x75,
    0xaa, 0x95, 0xe9, 0x82, 0x3d, 0x38, 0xa8, 0x4f,
    0xed, 0xd4, 0x16, 0x85, 0x6c, 0xdb, 0xa3, 0x7c,
];

// sUSDe→USDe redemption rate Pyth feed ID (yield accounting — replaces the
// JitoSOL stake-pool exchange rate read)
pub const SUSDE_USDE_RR_FEED_ID: [u8; 32] = [
    0x27, 0x1c, 0x64, 0xce, 0x45, 0x99, 0x37, 0xab,
    0xf7, 0x21, 0xd4, 0x25, 0x52, 0x03, 0x57, 0x13,
    0xb6, 0xc5, 0x8f, 0x80, 0xee, 0xce, 0xab, 0x71,
    0x6a, 0x62, 0x46, 0x07, 0xfd, 0xa4, 0xb1, 0x0f,
];

// Depeg guard tolerance: pause minting if market sUSDe/USD < redemption value * (100 - tolerance) / 100
pub const DEPEG_TOLERANCE_BPS: u64 = 300; // 3%

// sUSDe mainnet mint (Ethena staked USDe on Solana, verified 2026-10-12)
pub const SUSDE_MINT: &str = "Eh6XEPhSwoLv5wFApukmnaVSHQ6sAnoD9BmgmwQoN2sN";

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
