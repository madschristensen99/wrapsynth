use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use crate::state::{GlobalState, Vault};
use crate::error::ErrorCode;

#[derive(Accounts)]
pub struct WithdrawCollateral<'info> {
    #[account(mut)]
    pub vault: Account<'info, Vault>,
    
    #[account(
        seeds = [GlobalState::SEED_PREFIX],
        bump
    )]
    pub global_state: Account<'info, GlobalState>,
    
    #[account(
        mut,
        constraint = lp_collateral_account.owner == lp.key(),
        constraint = lp_collateral_account.mint == vault.collateral_mint
    )]
    pub lp_collateral_account: Account<'info, TokenAccount>,
    
    #[account(
        mut,
        constraint = vault_collateral_account.mint == vault.collateral_mint
    )]
    pub vault_collateral_account: Account<'info, TokenAccount>,
    
    /// CHECK: PDA signer for vault collateral account
    #[account(
        seeds = [Vault::SEED_PREFIX, vault.lp_address.as_ref(), vault.collateral_mint.as_ref()],
        bump
    )]
    pub vault_signer: UncheckedAccount<'info>,
    
    #[account(
        mut,
        constraint = lp.key() == vault.lp_address @ ErrorCode::Unauthorized
    )]
    pub lp: Signer<'info>,
    
    pub token_program: Program<'info, Token>,
}

pub fn handler(ctx: Context<WithdrawCollateral>, amount: u64) -> Result<()> {
    let vault = &mut ctx.accounts.vault;
    let global_state = &ctx.accounts.global_state;
    
    let available_collateral = vault.get_available_collateral();
    require!(
        amount <= available_collateral,
        ErrorCode::InsufficientCollateral
    );
    
    let actual_debt = vault.get_actual_debt(global_state.global_debt_index)?;
    if actual_debt > 0 {
        return Err(error!(ErrorCode::CannotWithdrawWithDebt));
    }
    
    let vault_seeds = &[
        Vault::SEED_PREFIX,
        vault.lp_address.as_ref(),
        vault.collateral_mint.as_ref(),
        &[ctx.bumps.vault_signer],
    ];
    let signer_seeds = &[&vault_seeds[..]];
    
    let transfer_ctx = CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        Transfer {
            from: ctx.accounts.vault_collateral_account.to_account_info(),
            to: ctx.accounts.lp_collateral_account.to_account_info(),
            authority: ctx.accounts.vault_signer.to_account_info(),
        },
        signer_seeds,
    );
    token::transfer(transfer_ctx, amount)?;
    
    vault.collateral_amount = vault.collateral_amount
        .checked_sub(amount)
        .ok_or(error!(ErrorCode::MathOverflow))?;
    
    msg!("Withdrawn {} collateral from vault", amount);
    msg!("Remaining collateral: {}", vault.collateral_amount);
    
    Ok(())
}
