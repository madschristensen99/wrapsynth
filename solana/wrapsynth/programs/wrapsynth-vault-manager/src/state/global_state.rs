use anchor_lang::prelude::*;

#[account]
pub struct GlobalState {
    /// Deployer/admin pubkey (one-time router setup)
    pub authority: Pubkey,
    /// wsXMR SPL Token 2022 mint address
    pub wsxmr_mint: Pubkey,
    /// Collateral SPL token mint (yield-bearing receipt token)
    pub collateral_mint: Pubkey,
    /// Authorized liquidity router program
    pub liquidity_router: Pubkey,
    /// Pyth XMR/USD price feed account
    pub pyth_xmr_feed: Pubkey,
    /// Pyth collateral/USD price feed account
    pub pyth_collateral_feed: Pubkey,

    /// Total wsXMR debt across all vaults (8 decimals)
    pub global_total_debt: u64,
    /// Debt multiplier for O(1) proportional forgiveness (scaled 1e18, stored as u64)
    /// Intermediates use u128 to avoid overflow
    pub global_debt_index: u64,
    /// Accumulated collateral yield ready for buy-and-burn
    pub yield_war_chest: u64,
    /// Total original deposit value across all LPs
    pub global_lp_principal: u64,
    /// Total original deposit shares across all LPs
    pub global_lp_principal_shares: u64,
    /// Pending collateral withdrawals queued in PendingReturns accounts
    pub global_pending_collateral: u64,
    /// Pending SOL/lamport withdrawals queued in PendingReturns accounts
    pub global_pending_sol: u64,
    /// Unbacked wsXMR from liquidation shortfalls
    pub global_bad_debt: u64,
    /// wsXMR debt currently locked in pending burn requests
    pub global_pending_burn_debt: u64,
    /// Unix timestamp of last buy-and-burn execution
    pub last_buy_timestamp: i64,
    /// Number of active vaults
    pub vault_count: u32,
    /// Global nonce for request ID generation
    pub request_nonce: u64,

    pub bump: u8,
}

impl GlobalState {
    /// Account discriminator + all fields.
    /// Pubkeys: 6 * 32 = 192
    /// u64s: 9 * 8 = 72
    /// i64: 8
    /// u32: 4
    /// u8: 1
    /// Total data: 277 + 8 discriminator = 285 → pad to 300
    pub const LEN: usize = 8 + 192 + 72 + 8 + 4 + 1 + 15; // = 300
}
