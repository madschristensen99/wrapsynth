/// Protocol constants — direct port from VaultManager.sol

// Collateral ratios (percentage, precision 100)
pub const COLLATERAL_RATIO: u64 = 150;
pub const LIQUIDATION_RATIO: u64 = 120;
pub const LIQUIDATION_BONUS: u64 = 110;
pub const RATIO_PRECISION: u64 = 100;
pub const BURN_LOCK_RATIO: u64 = 130;

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

// Pyth feed IDs (same as EVM contract)
pub const XMR_USD_FEED_ID: [u8; 32] = [
    0x46, 0xb8, 0xcc, 0x93, 0x47, 0xf0, 0x43, 0x91,
    0x76, 0x4a, 0x03, 0x61, 0xe0, 0xb1, 0x7c, 0x3b,
    0xa3, 0x94, 0xb0, 0x01, 0xe7, 0xc3, 0x04, 0xf7,
    0x65, 0x0f, 0x63, 0x76, 0xe3, 0x7c, 0x32, 0x1d,
];
// Collateral feed ID is set at runtime via GlobalState.pyth_collateral_feed
// (allows different collateral assets without redeployment)

// PDA seeds
pub const GLOBAL_STATE_SEED: &[u8] = b"global_state";
pub const VAULT_SEED: &[u8] = b"vault";
pub const MINT_REQUEST_SEED: &[u8] = b"mint_request";
pub const BURN_REQUEST_SEED: &[u8] = b"burn_request";
pub const PENDING_RETURNS_SEED: &[u8] = b"pending_returns";
pub const WSXMR_MINT_SEED: &[u8] = b"wsxmr_mint";
pub const VAULT_COLLATERAL_SEED: &[u8] = b"vault_collateral";
