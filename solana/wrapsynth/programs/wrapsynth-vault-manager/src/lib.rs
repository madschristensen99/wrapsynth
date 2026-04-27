use anchor_lang::prelude::*;

pub mod constants;
pub mod errors;
pub mod state;
pub mod utils;
pub mod instructions;

use instructions::*;

declare_id!("EZ1hsgYwmqmCY5Gzw9mwnJnJE4PJcKX5hHw5MZXk2ssy");

#[program]
pub mod wrapsynth_vault_manager {
    use super::*;

    // ── Initialization ────────────────────────────────────────────────────────

    pub fn initialize(
        ctx: Context<Initialize>,
        pyth_xmr_feed: Pubkey,
        pyth_collateral_feed: Pubkey,
        collateral_mint: Pubkey,
    ) -> Result<()> {
        initialize::handler(ctx, pyth_xmr_feed, pyth_collateral_feed, collateral_mint)
    }

    pub fn set_liquidity_router(
        ctx: Context<SetLiquidityRouter>,
        router: Pubkey,
    ) -> Result<()> {
        initialize::set_liquidity_router(ctx, router)
    }

    // ── Vault Management ──────────────────────────────────────────────────────

    pub fn create_vault(ctx: Context<CreateVault>) -> Result<()> {
        vault_management::create_vault(ctx)
    }

    pub fn initialize_vault_collateral(ctx: Context<InitializeVaultCollateral>) -> Result<()> {
        vault_management::initialize_vault_collateral(ctx)
    }

    pub fn deposit_collateral_shares(
        ctx: Context<DepositCollateral>,
        amount: u64,
    ) -> Result<()> {
        vault_management::deposit_collateral_shares(ctx, amount)
    }

    pub fn withdraw_collateral(
        ctx: Context<WithdrawCollateral>,
        amount: u64,
    ) -> Result<()> {
        vault_management::withdraw_collateral(ctx, amount)
    }

    pub fn set_mint_griefing_deposit(
        ctx: Context<UpdateVaultConfig>,
        deposit: u64,
    ) -> Result<()> {
        vault_management::set_mint_griefing_deposit(ctx, deposit)
    }

    pub fn set_vault_market_metrics(
        ctx: Context<UpdateVaultConfig>,
        mint_fee_bps: u16,
        burn_reward_bps: u16,
    ) -> Result<()> {
        vault_management::set_vault_market_metrics(ctx, mint_fee_bps, burn_reward_bps)
    }

    pub fn set_max_mint_bps(
        ctx: Context<UpdateVaultConfig>,
        max_mint_bps: u16,
    ) -> Result<()> {
        vault_management::set_max_mint_bps(ctx, max_mint_bps)
    }

    pub fn set_min_burn_amount(
        ctx: Context<UpdateVaultConfig>,
        min_amount: u64,
    ) -> Result<()> {
        vault_management::set_min_burn_amount(ctx, min_amount)
    }

    pub fn deactivate_vault(ctx: Context<DeactivateVault>) -> Result<()> {
        vault_management::deactivate_vault(ctx)
    }

    // ── Minting Flow ──────────────────────────────────────────────────────────

    pub fn initiate_mint(
        ctx: Context<InitiateMint>,
        xmr_amount: u64,
        claim_commitment: [u8; 32],
        timeout_duration: i64,
        request_id: [u8; 32],
    ) -> Result<()> {
        mint_flow::initiate_mint(ctx, xmr_amount, claim_commitment, timeout_duration, request_id)
    }

    pub fn set_mint_ready(ctx: Context<SetMintReady>) -> Result<()> {
        mint_flow::set_mint_ready(ctx)
    }

    pub fn finalize_mint(ctx: Context<FinalizeMint>, secret: [u8; 32]) -> Result<()> {
        mint_flow::finalize_mint(ctx, secret)
    }

    pub fn cancel_mint(ctx: Context<CancelMint>) -> Result<()> {
        mint_flow::cancel_mint(ctx)
    }

    // ── Burning Flow (3-step handshake) ───────────────────────────────────────

    pub fn request_burn(ctx: Context<RequestBurn>, wsxmr_amount: u64, request_id: [u8; 32]) -> Result<()> {
        burn_flow::request_burn(ctx, wsxmr_amount, request_id)
    }

    pub fn request_burn_from_router(
        ctx: Context<RequestBurn>,
        wsxmr_amount: u64,
        request_id: [u8; 32],
    ) -> Result<()> {
        burn_flow::request_burn_from_router(ctx, wsxmr_amount, request_id)
    }

    pub fn propose_hash(ctx: Context<ProposeHash>, secret_hash: [u8; 32]) -> Result<()> {
        burn_flow::propose_hash(ctx, secret_hash)
    }

    pub fn confirm_monero_lock(ctx: Context<ConfirmMoneroLock>) -> Result<()> {
        burn_flow::confirm_monero_lock(ctx)
    }

    pub fn finalize_burn(ctx: Context<FinalizeBurn>, secret: [u8; 32]) -> Result<()> {
        burn_flow::finalize_burn(ctx, secret)
    }

    pub fn claim_slashed_collateral(ctx: Context<ClaimSlashedCollateral>) -> Result<()> {
        burn_flow::claim_slashed_collateral(ctx)
    }

    pub fn cancel_burn(ctx: Context<CancelBurn>) -> Result<()> {
        burn_flow::cancel_burn(ctx)
    }

    // ── Liquidation ───────────────────────────────────────────────────────────

    /// Phase 1: resolve a single active burn on a liquidatable vault.
    /// Call once per active burn. Permissionless.
    pub fn resolve_burn_for_liquidation(
        ctx: Context<ResolveBurnForLiquidation>,
    ) -> Result<()> {
        liquidation::resolve_burn_for_liquidation(ctx)
    }

    /// Phase 2: execute the actual liquidation after all burns are resolved.
    pub fn execute_liquidation(
        ctx: Context<ExecuteLiquidation>,
        debt_to_clear: u64,
    ) -> Result<()> {
        liquidation::execute_liquidation(ctx, debt_to_clear)
    }

    // ── Buy-and-Burn ──────────────────────────────────────────────────────────

    pub fn trigger_buy_and_burn(
        ctx: Context<TriggerBuyAndBurn>,
        wsxmr_bought: u64,
    ) -> Result<()> {
        buy_and_burn::trigger_buy_and_burn(ctx, wsxmr_bought)
    }

    // ── Withdrawals ───────────────────────────────────────────────────────────

    pub fn initialize_pending_returns(
        ctx: Context<InitializePendingReturns>,
    ) -> Result<()> {
        withdrawals::initialize_pending_returns(ctx)
    }

    pub fn withdraw_collateral_returns(
        ctx: Context<WithdrawCollateralReturns>,
    ) -> Result<()> {
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
