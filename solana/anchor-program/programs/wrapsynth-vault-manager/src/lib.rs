use anchor_lang::prelude::*;

pub mod constants;
pub mod errors;
pub mod instructions;
pub mod state;
pub mod utils;

use instructions::*;

declare_id!("C9kVasKgQiUX1BCngBjorvMA8QaFyERHvdkYdwPyy3H1");

#[program]
pub mod wrapsynth_vault_manager {
    use super::*;

    // ── Initialization ────────────────────────────────────────────────────────

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        initialize::handler(ctx)
    }

    pub fn set_liquidity_router(ctx: Context<SetLiquidityRouter>, router: Pubkey) -> Result<()> {
        initialize::set_liquidity_router(ctx, router)
    }

    // ── Vault Management ──────────────────────────────────────────────────────

    pub fn create_vault(ctx: Context<CreateVault>) -> Result<()> {
        vault_management::create_vault(ctx)
    }


    pub fn deposit_collateral(ctx: Context<DepositCollateral>, amount: u64) -> Result<()> {
        vault_management::deposit_collateral(ctx, amount)
    }

    pub fn withdraw_collateral(ctx: Context<WithdrawCollateral>, amount: u64) -> Result<()> {
        vault_management::withdraw_collateral(ctx, amount)
    }

    pub fn set_mint_griefing_deposit(ctx: Context<UpdateVaultConfig>, deposit: u64) -> Result<()> {
        vault_management::set_mint_griefing_deposit(ctx, deposit)
    }

    pub fn set_vault_market_metrics(
        ctx: Context<UpdateVaultConfig>,
        mint_fee_bps: u16,
        burn_reward_bps: u16,
    ) -> Result<()> {
        vault_management::set_vault_market_metrics(ctx, mint_fee_bps, burn_reward_bps)
    }

    /// LP-declared collateral threshold: lamports per 1e8 wsXMR. Governs mint
    /// capacity, vault coverage, and par settlement (EVM setThreshold parity).
    pub fn set_threshold(ctx: Context<UpdateVaultConfig>, threshold: u128) -> Result<()> {
        vault_management::set_threshold(ctx, threshold)
    }

    /// LP-declared absolute mint cap in wsXMR units (0 = uncapped).
    /// (EVM setMaxMintWsxmr parity — replaces the price-relative max_mint_bps.)
    pub fn set_max_mint_wsxmr(ctx: Context<UpdateVaultConfig>, max_wsxmr: u64) -> Result<()> {
        vault_management::set_max_mint_wsxmr(ctx, max_wsxmr)
    }

    /// Burn wsXMR to reduce vault debt. In the kick grace window any amount
    /// cancels the kick; after grace only a full repay cancels the auction.
    /// (EVM repayDebt parity — replaces the mint-for-redemption hack.)
    pub fn repay_debt(ctx: Context<RepayDebt>, wsxmr_amount: u64) -> Result<()> {
        vault_management::repay_debt(ctx, wsxmr_amount)
    }

    pub fn set_min_burn_amount(ctx: Context<UpdateVaultConfig>, min_amount: u64) -> Result<()> {
        vault_management::set_min_burn_amount(ctx, min_amount)
    }

    pub fn set_mint_timeout(ctx: Context<UpdateVaultConfig>, seconds: i64) -> Result<()> {
        vault_management::set_mint_timeout(ctx, seconds)
    }

    pub fn set_burn_timeout(ctx: Context<UpdateVaultConfig>, seconds: i64) -> Result<()> {
        vault_management::set_burn_timeout(ctx, seconds)
    }

    pub fn set_minter_whitelist(
        ctx: Context<UpdateVaultConfig>,
        minter: Pubkey,
        whitelisted: bool,
    ) -> Result<()> {
        vault_management::set_minter_whitelist(ctx, minter, whitelisted)
    }

    pub fn batch_set_minter_whitelist(
        ctx: Context<UpdateVaultConfig>,
        minters: Vec<Pubkey>,
        whitelisted: bool,
    ) -> Result<()> {
        vault_management::batch_set_minter_whitelist(ctx, minters, whitelisted)
    }

    pub fn deactivate_vault(ctx: Context<DeactivateVault>) -> Result<()> {
        vault_management::deactivate_vault(ctx)
    }

    // ── Minting Flow ──────────────────────────────────────────────────────────

    pub fn initiate_mint(
        ctx: Context<InitiateMint>,
        xmr_amount: u64,
        claim_commitment: [u8; 32],
        user_public_key: [u8; 32],
        request_id: [u8; 32],
    ) -> Result<()> {
        mint_flow::initiate_mint(
            ctx,
            xmr_amount,
            claim_commitment,
            user_public_key,
            request_id,
        )
    }

    pub fn provide_lp_key(
        ctx: Context<ProvideLPKey>,
        lp_public_spend_key: [u8; 32],
        lp_public_view_key: [u8; 32],
        lp_commitment: [u8; 32],
    ) -> Result<()> {
        mint_flow::provide_lp_key(ctx, lp_public_spend_key, lp_public_view_key, lp_commitment)
    }

    pub fn set_mint_ready(ctx: Context<SetMintReady>) -> Result<()> {
        mint_flow::set_mint_ready(ctx)
    }

    pub fn reveal_secret(ctx: Context<RevealSecret>, secret: [u8; 32]) -> Result<()> {
        mint_flow::reveal_secret(ctx, secret)
    }

    pub fn finalize_mint(ctx: Context<FinalizeMint>) -> Result<()> {
        mint_flow::finalize_mint(ctx)
    }

    pub fn cancel_mint(ctx: Context<CancelMint>) -> Result<()> {
        mint_flow::cancel_mint(ctx)
    }

    pub fn abandon_key_provided_mint(
        ctx: Context<AbandonKeyProvidedMint>,
        lp_secret: [u8; 32],
    ) -> Result<()> {
        mint_flow::abandon_key_provided_mint(ctx, lp_secret)
    }

    pub fn reclaim_parked_deposit(ctx: Context<ReclaimParkedDeposit>) -> Result<()> {
        mint_flow::reclaim_parked_deposit(ctx)
    }

    pub fn claim_griefing_deposit(
        ctx: Context<ClaimGriefingDeposit>,
        lp_secret: [u8; 32],
    ) -> Result<()> {
        mint_flow::claim_griefing_deposit(ctx, lp_secret)
    }

    pub fn sweep_unclaimed_expired_mint(ctx: Context<SweepUnclaimedExpiredMint>) -> Result<()> {
        mint_flow::sweep_unclaimed_expired_mint(ctx)
    }

    // ── Burning Flow (3-step handshake) ───────────────────────────────────────

    pub fn request_burn(
        ctx: Context<RequestBurn>,
        wsxmr_amount: u64,
        claim_commitment: [u8; 32],
        user_public_key: [u8; 32],
        user_view_key: [u8; 32],
        request_id: [u8; 32],
    ) -> Result<()> {
        burn_flow::request_burn(
            ctx,
            wsxmr_amount,
            claim_commitment,
            user_public_key,
            user_view_key,
            request_id,
        )
    }

    pub fn request_burn_from_router(
        ctx: Context<RequestBurn>,
        wsxmr_amount: u64,
        claim_commitment: [u8; 32],
        user_public_key: [u8; 32],
        user_view_key: [u8; 32],
        request_id: [u8; 32],
    ) -> Result<()> {
        burn_flow::request_burn_from_router(
            ctx,
            wsxmr_amount,
            claim_commitment,
            user_public_key,
            user_view_key,
            request_id,
        )
    }

    pub fn propose_hash(
        ctx: Context<ProposeHash>,
        secret_hash: [u8; 32],
        lp_public_spend_key: [u8; 32],
        lp_public_view_key: [u8; 32],
    ) -> Result<()> {
        burn_flow::propose_hash(ctx, secret_hash, lp_public_spend_key, lp_public_view_key)
    }

    pub fn confirm_monero_lock(ctx: Context<ConfirmMoneroLock>) -> Result<()> {
        burn_flow::confirm_monero_lock(ctx)
    }

    pub fn reveal_burn_secret(ctx: Context<RevealBurnSecret>, secret: [u8; 32]) -> Result<()> {
        burn_flow::reveal_burn_secret(ctx, secret)
    }

    pub fn settle_burn(ctx: Context<SettleBurn>) -> Result<()> {
        burn_flow::settle_burn(ctx)
    }

    pub fn finalize_burn(ctx: Context<FinalizeBurn>, secret: [u8; 32]) -> Result<()> {
        burn_flow::finalize_burn(ctx, secret)
    }

    pub fn claim_slashed_collateral(
        ctx: Context<ClaimSlashedCollateral>,
        user_secret: [u8; 32],
    ) -> Result<()> {
        burn_flow::claim_slashed_collateral(ctx, user_secret)
    }

    pub fn abort_burn(ctx: Context<AbortBurn>) -> Result<()> {
        burn_flow::abort_burn(ctx)
    }

    pub fn force_settle_burn(ctx: Context<ForceSettleBurn>) -> Result<()> {
        burn_flow::force_settle_burn(ctx)
    }

    pub fn resolve_declined_proposal(
        ctx: Context<ResolveDeclinedProposal>,
        user_secret: [u8; 32],
    ) -> Result<()> {
        burn_flow::resolve_declined_proposal(ctx, user_secret)
    }

    pub fn abandon_proposed_burn(ctx: Context<AbandonProposedBurn>) -> Result<()> {
        burn_flow::abandon_proposed_burn(ctx)
    }

    // ── Auction Liquidation (permissionless kick → Dutch auction) ────────────

    /// Kick a vault — post a bond and open the grace window. Permissionless;
    /// no solvency proof required. (EVM kick parity.)
    pub fn kick(ctx: Context<Kick>) -> Result<()> {
        auction::kick(ctx)
    }

    /// Retry liquidation on a frozen vault — exactly once. (EVM reauction parity.)
    pub fn reauction(ctx: Context<Reauction>) -> Result<()> {
        auction::reauction(ctx)
    }

    /// Resolve a single active burn on a kicked vault — permissionless,
    /// callable once the grace window has elapsed. Call once per active burn
    /// before open_auction.
    pub fn resolve_burn_for_auction(ctx: Context<ResolveBurnForAuction>) -> Result<()> {
        auction::resolve_burn_for_auction(ctx)
    }

    /// Open the auction — permissionless, idempotent. Requires all in-flight
    /// burns resolved and co-LP positions unwound; snapshots the offered
    /// collateral and bumps both nonces.
    pub fn open_auction(ctx: Context<OpenAuction>) -> Result<()> {
        auction::open_auction(ctx)
    }

    /// Bid — burn the vault's FULL actual debt in wsXMR for X(t)% of the
    /// offered collateral. Whole-debt bids only. (EVM bid parity.)
    pub fn bid(ctx: Context<Bid>) -> Result<()> {
        auction::bid(ctx)
    }

    /// Resolve a no-bid auction — freeze the vault, return the bond.
    /// (EVM resolveKick parity.)
    pub fn resolve_kick(ctx: Context<ResolveKick>) -> Result<()> {
        auction::resolve_kick(ctx)
    }

    /// A healthy LP assumes the debt and collateral of a frozen vault.
    /// (EVM backstopVault parity.)
    pub fn backstop_vault(ctx: Context<BackstopVault>) -> Result<()> {
        auction::backstop_vault(ctx)
    }

    // ── Co-LP (Orca Whirlpools) ───────────────────────────────────────────────

    /// LP sets the preferred max co-LP range width (basis points).
    pub fn set_max_co_lp_range(ctx: Context<SetMaxCoLPRange>, bps: u16) -> Result<()> {
        co_lp::set_max_co_lp_range(ctx, bps)
    }

    /// User pairs wsXMR with vault idle SOL collateral to open a position.
    /// Both leg amounts are caller-supplied (EVM userOpenCoLP parity).
    pub fn user_open_co_lp<'info>(
        ctx: Context<'_, '_, '_, 'info, UserOpenCoLP<'info>>,
        wsxmr_amount: u64,
        collateral_amount: u64,
        nonce: u64,
    ) -> Result<()> {
        co_lp::user_open_co_lp(ctx, wsxmr_amount, collateral_amount, nonce)
    }

    /// LP or user collects accrued fees from a co-LP position.
    pub fn collect_co_lp_fees<'info>(
        ctx: Context<'_, '_, '_, 'info, CollectCoLPFees<'info>>,
    ) -> Result<()> {
        co_lp::collect_co_lp_fees(ctx)
    }

    /// LP or user closes a co-LP position and distributes proceeds.
    pub fn unwind_co_lp<'info>(ctx: Context<'_, '_, '_, 'info, UnwindCoLP<'info>>) -> Result<()> {
        co_lp::unwind_co_lp(ctx)
    }

    /// Keeper drains a co-LP position for rebalancing (re-open via user_open_co_lp).
    pub fn rebalance_co_lp<'info>(
        ctx: Context<'_, '_, '_, 'info, RebalanceCoLP<'info>>,
        new_range_bps: u16,
    ) -> Result<()> {
        co_lp::rebalance_co_lp(ctx, new_range_bps)
    }

    // ── Withdrawals ───────────────────────────────────────────────────────────

    pub fn initialize_pending_returns(ctx: Context<InitializePendingReturns>) -> Result<()> {
        withdrawals::initialize_pending_returns(ctx)
    }

    pub fn withdraw_collateral_returns(ctx: Context<WithdrawCollateralReturns>) -> Result<()> {
        withdrawals::withdraw_collateral_returns(ctx)
    }

    pub fn withdraw_sol_returns(ctx: Context<WithdrawSolReturns>) -> Result<()> {
        withdrawals::withdraw_sol_returns(ctx)
    }

    // ── Reconciliation ────────────────────────────────────────────────────────

    pub fn reconcile_global_debt(ctx: Context<ReconcileGlobalDebt>) -> Result<()> {
        reconciliation::reconcile_global_debt(ctx)
    }
}

#[cfg(test)]
pub mod tests;
