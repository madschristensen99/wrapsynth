use anchor_lang::prelude::*;

use crate::constants::MAX_VAULTS;

#[account(zero_copy)]
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
    /// Total principal value in USDe terms (9 decimals) for sUSDe yield tracking
    pub global_lp_principal_value: u64,
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
    /// Batch debt-wipe progress: 0 = idle, 1-indexed next vault to zero
    pub debt_wipe_batch_start: u64,
    /// Batch index-migration progress: 0 = idle, 1-indexed next vault to rescale
    pub migration_batch_start: u64,
    /// Old index captured when a batch migration starts
    pub migration_old_index: u64,
    /// Global nonce for request ID generation
    pub request_nonce: u64,
    /// Number of active vaults
    pub vault_count: u32,
    /// Number of mints in READY state across all vaults — blocks buy-and-burn until resolved
    pub total_pending_mints: u32,
    /// Fixed-size vault list (LP pubkeys) — authoritative ordering for batch
    /// debt wipe / index migration (EVM vaultList parity, capped at MAX_VAULTS)
    pub vault_list: [Pubkey; MAX_VAULTS],
    pub bump: u8,
    /// Explicit padding so the struct is Pod-compatible (no implicit alignment padding)
    pub _reserved: [u8; 7],
}

impl GlobalState {
    /// Account discriminator + all fields (zero-copy, no implicit padding).
    /// Pubkeys: 5 * 32 = 160
    /// u64s: 14 * 8 = 112 (incl. request_nonce)
    /// i64: 8
    /// u32s: 2 * 4 = 8
    /// vault_list: MAX_VAULTS * 32 = 4096
    /// u8 bump + 7 reserved = 8
    /// Total data: 8 + 160 + 112 + 8 + 8 + 4096 + 8 = 4400
    pub const LEN: usize = 8 + 160 + 112 + 8 + 8 + 4096 + 8; // = 4400
}
