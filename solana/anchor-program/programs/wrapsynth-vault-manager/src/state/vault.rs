use anchor_lang::prelude::*;

use crate::constants::MAX_WHITELISTED_MINTERS;

#[account]
pub struct Vault {
    /// LP owner of this vault
    pub lp_address: Pubkey,
    /// Collateral token shares held (excludes locked_collateral — locked is deducted here)
    pub collateral_amount: u64,
    /// Collateral reserved for pending burns (physically deducted from collateral_amount)
    pub locked_collateral: u64,
    /// Normalized debt: actual_debt = normalized_debt * global_debt_index / 1e18
    pub normalized_debt: u64,
    /// Reserved capacity for pending mints (not liquidatable)
    pub pending_debt: u64,
    /// LP-configured max single mint size in basis points (0 = no limit)
    pub max_mint_bps: u16,
    /// SOL lamports required per mint request (anti-spam griefing deposit)
    pub mint_griefing_deposit: u64,
    /// Fee LP charges for minting (basis points, max 1000)
    pub mint_fee_bps: u16,
    /// Reward LP pays to incentivize burning (basis points, max 1000)
    pub burn_reward_bps: u16,
    /// Incremented on liquidation to invalidate all pending burns
    pub liquidation_nonce: u64,
    /// Incremented on liquidation to invalidate all pending mints
    pub mint_nonce: u64,
    /// LP-configurable minimum burn amount (0 = use global default)
    pub min_burn_amount: u64,
    /// Original deposit value (for yield tracking)
    pub principal_deposits: u64,
    /// Original deposit shares (for yield tracking)
    pub principal_shares: u64,
    /// Principal value in USDe terms (9 decimals) for sUSDe yield detection.
    /// Tracks the USDe-equivalent value at deposit time via the sUSDe→USDe
    /// redemption rate (Pyth SUSDE/USDE.RR)
    pub principal_value: u64,
    /// Number of currently active (non-terminal) burn requests
    pub active_burn_count: u32,
    /// Number of mints in READY state — blocks state-changing vault ops until resolved
    pub pending_mint_count: u32,
    /// LP-configured mint request timeout in seconds (EVM mintTimeoutBlocks parity)
    pub mint_timeout_seconds: i64,
    /// LP-configured burn request timeout in seconds (EVM burnTimeoutBlocks parity)
    pub burn_timeout_seconds: i64,
    /// Whitelisted minters that bypass the griefing deposit (EVM whitelistedMinters parity)
    pub whitelisted_minters: [Pubkey; MAX_WHITELISTED_MINTERS],
    /// Number of entries in whitelisted_minters
    pub whitelisted_minter_count: u32,
    pub active: bool,
    pub bump: u8,
}

impl Vault {
    /// 8 disc + 32 + 11*8 + 3*2 + 3*4 + 2*8 (timeouts) + 32*32 (whitelist)
    /// + 1 + 1 = 8+32+88+6+12+16+1024+2 = 1188 → pad to 1200
    pub const LEN: usize = 1200;
}
