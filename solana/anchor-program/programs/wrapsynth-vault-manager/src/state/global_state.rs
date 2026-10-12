use anchor_lang::prelude::*;

use crate::constants::MAX_VAULTS;

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
    /// Total principal value in SOL terms (lamports) for JitoSOL yield tracking
    pub global_lp_principal_sol_value: u64,
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
    /// Fixed-size vault list (LP pubkeys) — authoritative ordering for batch
    /// debt wipe / index migration (EVM vaultList parity, capped at MAX_VAULTS)
    pub vault_list: [Pubkey; MAX_VAULTS],
    /// Batch debt-wipe progress: 0 = idle, 1-indexed next vault to zero
    pub debt_wipe_batch_start: u64,
    /// Batch index-migration progress: 0 = idle, 1-indexed next vault to rescale
    pub migration_batch_start: u64,
    /// Old index captured when a batch migration starts
    pub migration_old_index: u64,
    /// Number of mints in READY state across all vaults — blocks buy-and-burn until resolved
    pub total_pending_mints: u32,
    /// Global nonce for request ID generation
    pub request_nonce: u64,

    pub bump: u8,
}

impl GlobalState {
    /// Account discriminator + all fields.
    /// Pubkeys: 5 * 32 = 160 (removed pyth_collateral_feed)
    /// u64s: 13 * 8 = 104 (added batch wipe/migration state)
    /// i64: 8
    /// u32s: 2 * 4 = 8 (added total_pending_mints)
    /// vault_list: MAX_VAULTS * 32 = 4096
    /// u8: 1
    /// Total data: 8 + 160 + 104 + 8 + 8 + 4096 + 1 = 4385 → pad to 4392
    pub const LEN: usize = 8 + 160 + 104 + 8 + 8 + 4096 + 1 + 7; // = 4392
}
