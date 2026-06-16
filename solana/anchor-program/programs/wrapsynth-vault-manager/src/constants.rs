/// Protocol constants — direct port from VaultManager.sol

// Collateral ratios (percentage, precision 100)
// Tuned for volatile LST collateral (JitoSOL) where BOTH collateral and debt legs move.
// With sDAI only the XMR leg moved; with JitoSOL both JitoSOL/USD and XMR/USD are volatile.
// The offsetting factor is SOL↔XMR positive correlation dampening JitoSOL/XMR ratio volatility.
// 180/150 is a defensible midpoint pending backtest of worst adverse JitoSOL/XMR move.
pub const COLLATERAL_RATIO: u64 = 180;      // mint floor (was 150)
pub const LIQUIDATION_RATIO: u64 = 150;     // liquidate below this (was 120)
pub const LIQUIDATION_BONUS: u64 = 112;     // liquidator incentive (was 110)
pub const RATIO_PRECISION: u64 = 100;
pub const BURN_LOCK_RATIO: u64 = 160;       // reserve for in-flight burns (was 130)
pub const YIELD_BUFFER_RATIO: u64 = 190;    // CR + 10 headroom after yield extraction

// Compile-time invariant checks — these must hold or the program fails to compile.
// Ordering: LIQUIDATION_RATIO < COLLATERAL_RATIO < YIELD_BUFFER_RATIO
// Burn lock must sit above liquidation so locked collateral survives drops through handshake window.
const _: () = assert!(LIQUIDATION_RATIO < COLLATERAL_RATIO,
    "LIQUIDATION_RATIO must be < COLLATERAL_RATIO");
const _: () = assert!(COLLATERAL_RATIO < YIELD_BUFFER_RATIO,
    "COLLATERAL_RATIO must be < YIELD_BUFFER_RATIO");
const _: () = assert!(LIQUIDATION_RATIO < BURN_LOCK_RATIO,
    "LIQUIDATION_RATIO must be < BURN_LOCK_RATIO");
const _: () = assert!(BURN_LOCK_RATIO <= COLLATERAL_RATIO + 10,
    "BURN_LOCK_RATIO must not exceed COLLATERAL_RATIO + 10");

// Precision constants
pub const PRICE_PRECISION: u64 = 1_000_000_000_000_000_000; // 1e18
pub const WSXMR_DECIMALS: u64 = 100_000_000;                 // 1e8
pub const DEBT_INDEX_PRECISION: u64 = 1_000_000_000_000_000_000; // 1e18
pub const XMR_TO_WSXMR_DIVISOR: u64 = 10_000;               // 1e4 (12 dec → 8 dec)

// Timeouts (seconds)
pub const MAX_MINT_TIMEOUT: i64 = 7_200;    // 2 hours
pub const MINT_READY_EXTENSION: i64 = 7_200; // 2 hours
pub const BURN_REQUEST_TIMEOUT: i64 = 3_600; // 1 hour
pub const BURN_COMMIT_TIMEOUT: i64 = 7_200;  // 2 hours
pub const GRACE_PERIOD: i64 = 900;           // 15 minutes

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

// JitoSOL/USD Pyth feed ID (verified from Hermes API 2026-06-14)
pub const JITOSOL_USD_FEED_ID: [u8; 32] = [
    0x67, 0xbe, 0x9f, 0x51, 0x9b, 0x95, 0xcf, 0x24,
    0x33, 0x88, 0x01, 0x05, 0x1f, 0x9a, 0x80, 0x8e,
    0xff, 0x0a, 0x57, 0x8c, 0xcb, 0x38, 0x8d, 0xb7,
    0x3b, 0x7f, 0x6f, 0xe1, 0xde, 0x01, 0x9f, 0xfb,
];

// SOL/USD Pyth feed ID (verified from Hermes API 2026-06-14)
pub const SOL_USD_FEED_ID: [u8; 32] = [
    0xef, 0x0d, 0x8b, 0x6f, 0xda, 0x2c, 0xce, 0xd6,
    0x91, 0x3b, 0xdc, 0xb2, 0x8c, 0x05, 0x54, 0xf6,
    0x59, 0xe5, 0x5e, 0x8f, 0x88, 0x09, 0xf8, 0x85,
    0x2b, 0x24, 0xe7, 0xdc, 0xfb, 0x75, 0xad, 0x54,
];

// Depeg guard tolerance: pause minting if market JitoSOL/USD < fair value * (100 - tolerance) / 100
pub const DEPEG_TOLERANCE_BPS: u64 = 300; // 3%

// JitoSOL mainnet addresses (verified from jito.network docs 2026-06-14)
// Stake Pool account: Jito4APyf642JPZPx3hGc6WWJ8zPKtRbRs4P815Awbb
pub const JITOSOL_STAKE_POOL: &str = "Jito4APyf642JPZPx3hGc6WWJ8zPKtRbRs4P815Awbb";
// JitoSOL mint: J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn
pub const JITOSOL_MINT: &str = "J1toso1uCk3RLmjorhTtrVwY9HJ7X8V9yYac6Y7kGCPn";
// SPL Stake Pool program: SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy
pub const SPL_STAKE_POOL_PROGRAM: &str = "SPoo1Ku8WFXoNDMHPsrGSTSG1Y47rzgn41SLUNakuHy";

// PDA seeds
pub const GLOBAL_STATE_SEED: &[u8] = b"global_state";
pub const VAULT_SEED: &[u8] = b"vault";
pub const MINT_REQUEST_SEED: &[u8] = b"mint_request";
pub const BURN_REQUEST_SEED: &[u8] = b"burn_request";
pub const PENDING_RETURNS_SEED: &[u8] = b"pending_returns";
pub const WSXMR_MINT_SEED: &[u8] = b"wsxmr_mint";
pub const VAULT_COLLATERAL_SEED: &[u8] = b"vault_collateral";
