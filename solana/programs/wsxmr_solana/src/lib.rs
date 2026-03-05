use anchor_lang::prelude::*;

pub mod constants;
pub mod error;
pub mod instructions;
pub mod state;
pub mod utils;

use instructions::*;

declare_id!("wsxmrso1ana11111111111111111111111111111111");

#[program]
pub mod wsxmr_solana {
    use super::*;

    pub fn initialize_global(
        ctx: Context<InitializeGlobal>,
        price_max_age: u64,
    ) -> Result<()> {
        instructions::initialize_global::handler(ctx, price_max_age)
    }

    pub fn create_vault(
        ctx: Context<CreateVault>,
        collateral_mint: Pubkey,
    ) -> Result<()> {
        instructions::create_vault::handler(ctx, collateral_mint)
    }

    pub fn deposit_collateral(
        ctx: Context<DepositCollateral>,
        amount: u64,
    ) -> Result<()> {
        instructions::deposit_collateral::handler(ctx, amount)
    }

    pub fn withdraw_collateral(
        ctx: Context<WithdrawCollateral>,
        amount: u64,
    ) -> Result<()> {
        instructions::withdraw_collateral::handler(ctx, amount)
    }

    pub fn set_vault_params(
        ctx: Context<SetVaultParams>,
        mint_fee_bps: u16,
        burn_reward_bps: u16,
        max_mint_bps: u16,
        mint_griefing_deposit: u64,
        active: bool,
    ) -> Result<()> {
        instructions::set_vault_params::handler(
            ctx,
            mint_fee_bps,
            burn_reward_bps,
            max_mint_bps,
            mint_griefing_deposit,
            active,
        )
    }

    pub fn initiate_mint(
        ctx: Context<InitiateMint>,
        wsxmr_amount: u64,
        claim_commitment: [u8; 32],
        timeout_duration: i64,
    ) -> Result<()> {
        instructions::initiate_mint::handler(ctx, wsxmr_amount, claim_commitment, timeout_duration)
    }

    pub fn confirm_mint(
        ctx: Context<ConfirmMint>,
    ) -> Result<()> {
        instructions::confirm_mint::handler(ctx)
    }

    pub fn finalize_mint(
        ctx: Context<FinalizeMint>,
        secret: [u8; 32],
    ) -> Result<()> {
        instructions::finalize_mint::handler(ctx, secret)
    }

    pub fn cancel_mint(
        ctx: Context<CancelMint>,
    ) -> Result<()> {
        instructions::cancel_mint::handler(ctx)
    }

    pub fn request_burn(
        ctx: Context<RequestBurn>,
        wsxmr_amount: u64,
        secret_hash: [u8; 32],
    ) -> Result<()> {
        instructions::request_burn::handler(ctx, wsxmr_amount, secret_hash)
    }

    pub fn propose_burn(
        ctx: Context<ProposeBurn>,
        secret_hash: [u8; 32],
    ) -> Result<()> {
        instructions::propose_burn::handler(ctx, secret_hash)
    }

    pub fn commit_burn(
        ctx: Context<CommitBurn>,
    ) -> Result<()> {
        instructions::commit_burn::handler(ctx)
    }

    pub fn finalize_burn(
        ctx: Context<FinalizeBurn>,
        secret: [u8; 32],
    ) -> Result<()> {
        instructions::finalize_burn::handler(ctx, secret)
    }

    pub fn claim_slashed_collateral(
        ctx: Context<ClaimSlashedCollateral>,
    ) -> Result<()> {
        instructions::claim_slashed_collateral::handler(ctx)
    }

    pub fn cancel_burn(
        ctx: Context<CancelBurn>,
    ) -> Result<()> {
        instructions::cancel_burn::handler(ctx)
    }

    pub fn liquidate(
        ctx: Context<Liquidate>,
        debt_amount: u64,
    ) -> Result<()> {
        instructions::liquidate::handler(ctx, debt_amount)
    }

    pub fn harvest_yield(
        ctx: Context<HarvestYield>,
    ) -> Result<()> {
        instructions::harvest_yield::handler(ctx)
    }
}
