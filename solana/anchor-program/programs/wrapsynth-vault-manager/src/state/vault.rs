use anchor_lang::prelude::*;

use crate::constants::MAX_WHITELISTED_MINTERS;

#[account]
pub struct Vault {
    /// LP owner of this vault
    pub lp_address: Pubkey,
    /// Raw lamport collateral held — TOTAL model: includes locked_collateral, so
    /// available = collateral_amount - locked_collateral - deployed_collateral
    pub collateral_amount: u64,
    /// Collateral reserved for pending burns/mints (still inside collateral_amount)
    pub locked_collateral: u64,
    /// Normalized debt: actual_debt = normalized_debt * global_debt_index / 1e18
    pub normalized_debt: u64,
    /// Reserved capacity for pending mints (not liquidatable)
    pub pending_debt: u64,
    /// LP-declared par rate: lamports of collateral per 1e8 wsXMR. Defines mint
    /// capacity, coverage, and par settlement — the oracle-free replacement for
    /// price-derived collateral ratios (EVM thresholdSharesPerWsxmr parity).
    pub threshold_lamports_per_wsxmr: u128,
    /// LP-configured absolute max single mint size in wsXMR (0 = no limit)
    /// (EVM maxMintWsxmr parity — replaces the price-relative max_mint_bps)
    pub max_mint_wsxmr: u64,
    /// SOL lamports required per mint request (anti-spam griefing deposit)
    pub mint_griefing_deposit: u64,
    /// Fee LP charges for minting (basis points, max 1000)
    pub mint_fee_bps: u16,
    /// Reward LP pays to incentivize burning (basis points, max 1000)
    pub burn_reward_bps: u16,
    /// Incremented on auction open to invalidate all pending burns
    pub liquidation_nonce: u64,
    /// Incremented on auction open to invalidate all pending mints
    pub mint_nonce: u64,
    /// LP-configurable minimum burn amount (0 = use global default)
    pub min_burn_amount: u64,
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
    /// Collateral (lamports, deployed as wSOL) in co-LP positions (excluded from liquid balance)
    pub deployed_collateral: u64,
    /// LP's preferred max co-LP range width in basis points (EVM maxCoLPRangeBps parity)
    pub max_co_lp_range_bps: u16,
    /// A kick/auction is live on this vault — new mints/burns/withdrawals revert
    pub kick_active: bool,
    /// Vault froze after an inconclusive auction — only repay_debt,
    /// deposit_collateral, reauction and backstop_vault remain
    pub frozen: bool,
    /// One-shot retry flag: true once a frozen vault has been reauctioned
    pub reauction_used: bool,
    /// Timestamp of the last kick resolution — enforces KICK_COOLDOWN_SECONDS
    pub last_kick_resolved: i64,
    pub active: bool,
    pub bump: u8,
}

impl Vault {
    /// 8 disc + 32 + 8*5 + 16 (threshold) + 2*2 + 3*4 + 2*8 (timeouts)
    /// + 32*32 (whitelist) + 8 (deployed) + 2 (max range)
    /// + 4*1 (flags) + 8 (last_kick) + 1 + 1 = 1217 → pad to 1224
    pub const LEN: usize = 1224;
}
