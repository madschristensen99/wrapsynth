use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use crate::state::{GlobalState, Vault, BurnRequest, BurnStatus};
use crate::error::ErrorCode;

#[derive(Accounts)]
pub struct ClaimSlashedCollateral<'info> {
    #[account(
        mut,
        constraint = burn_request.get_status() == BurnStatus::Committed @ ErrorCode::InvalidRequestStatus,
        constraint = burn_request.user == user.key() @ ErrorCode::Unauthorized
    )]
    pub burn_request: Account<'info, BurnRequest>,
    
    #[account(mut)]
    pub vault: Account<'info, Vault>,
    
    #[account(
        mut,
        seeds = [GlobalState::SEED_PREFIX],
        bump
    )]
    pub global_state: Account<'info, GlobalState>,
    
    #[account(
        mut,
        constraint = vault_collateral_account.mint == vault.collateral_mint
    )]
    pub vault_collateral_account: Account<'info, TokenAccount>,
    
    #[account(
        mut,
        constraint = user_collateral_account.mint == vault.collateral_mint,
        constraint = user_collateral_account.owner == user.key()
    )]
    pub user_collateral_account: Account<'info, TokenAccount>,
    
    /// CHECK: PDA signer for vault
    #[account(
        seeds = [Vault::SEED_PREFIX, vault.lp_address.as_ref(), vault.collateral_mint.as_ref()],
        bump
    )]
    pub vault_signer: UncheckedAccount<'info>,
    
    pub user: Signer<'info>,
    
    pub token_program: Program<'info, Token>,
    pub clock: Sysvar<'info, Clock>,
}

pub fn handler(ctx: Context<ClaimSlashedCollateral>) -> Result<()> {
    let burn_request = &mut ctx.accounts.burn_request;
    let vault = &mut ctx.accounts.vault;
    let global_state = &mut ctx.accounts.global_state;
    let clock = &ctx.accounts.clock;
    
    require!(
        clock.unix_timestamp > burn_request.deadline,
        ErrorCode::DeadlineNotReached
    );
    
    let vault_seeds = &[
        Vault::SEED_PREFIX,
        vault.lp_address.as_ref(),
        vault.collateral_mint.as_ref(),
        &[ctx.bumps.vault_signer],
    ];
    let signer_seeds = &[&vault_seeds[..]];
    
    let total_collateral = burn_request.locked_collateral
        .checked_add(burn_request.reward_collateral)
        .ok_or(error!(ErrorCode::MathOverflow))?;
    
    let transfer_ctx = CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        Transfer {
            from: ctx.accounts.vault_collateral_account.to_account_info(),
            to: ctx.accounts.user_collateral_account.to_account_info(),
            authority: ctx.accounts.vault_signer.to_account_info(),
        },
        signer_seeds,
    );
    token::transfer(transfer_ctx, total_collateral)?;
    
    vault.locked_collateral = vault.locked_collateral
        .checked_sub(total_collateral)
        .ok_or(error!(ErrorCode::MathOverflow))?;
    
    vault.collateral_amount = vault.collateral_amount
        .checked_sub(total_collateral)
        .ok_or(error!(ErrorCode::MathOverflow))?;
    
    let debt_to_reduce = (burn_request.wsxmr_amount as u128)
        .checked_mul(GlobalState::DEBT_INDEX_PRECISION as u128)
        .ok_or(error!(ErrorCode::MathOverflow))?
        .checked_div(global_state.global_debt_index as u128)
        .ok_or(error!(ErrorCode::MathOverflow))?;
    
    vault.normalized_debt = vault.normalized_debt
        .checked_sub(debt_to_reduce as u64)
        .ok_or(error!(ErrorCode::MathOverflow))?;
    
    burn_request.set_status(BurnStatus::Slashed);
    
    msg!("LP slashed - collateral claimed by user");
    msg!("Total collateral seized: {}", total_collateral);
    
    Ok(())
}
