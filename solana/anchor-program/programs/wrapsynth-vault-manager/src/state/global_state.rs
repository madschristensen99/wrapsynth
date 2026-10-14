use anchor_lang::prelude::*;

#[account(zero_copy)]
pub struct GlobalState {
    /// Deployer/admin pubkey (one-time router setup)
    pub authority: Pubkey,
    /// wsXMR SPL Token 2022 mint address
    pub wsxmr_mint: Pubkey,
    /// Collateral SPL token mint (raw QQQx, no yield wrapper)
    pub collateral_mint: Pubkey,
    /// Authorized liquidity router program
    pub liquidity_router: Pubkey,
    /// Pyth XMR/USD price feed account
    pub pyth_xmr_feed: Pubkey,

    /// Total wsXMR debt across all vaults (8 decimals)
    pub global_total_debt: u64,
    /// Debt multiplier for O(1) proportional forgiveness (scaled 1e18, stored as u64).
    /// Fixed at INITIAL_DEBT_INDEX — no buy-and-burn modifies it, but the
    /// normalized-debt machinery is retained for EVM accounting parity.
    pub global_debt_index: u64,
    /// Pending collateral withdrawals queued in PendingReturns accounts.
    /// Backed by the program_collateral_ata pool.
    pub global_pending_collateral: u64,
    /// Pending SOL/lamport withdrawals queued in PendingReturns accounts
    pub global_pending_sol: u64,
    /// Unbacked wsXMR from liquidation shortfalls
    pub global_bad_debt: u64,
    /// wsXMR debt currently locked in pending burn requests
    pub global_pending_burn_debt: u64,
    /// Global nonce for request ID generation
    pub request_nonce: u64,
    pub bump: u8,
    /// Explicit padding so the struct is Pod-compatible (no implicit alignment padding)
    pub _reserved: [u8; 7],
}

impl GlobalState {
    /// Account discriminator + all fields (zero-copy, no implicit padding).
    /// Pubkeys: 5 * 32 = 160
    /// u64s: 7 * 8 = 56
    /// u8 bump + 7 reserved = 8
    /// Total data: 8 + 160 + 56 + 8 = 232
    pub const LEN: usize = 8 + 160 + 56 + 8; // = 232
}
