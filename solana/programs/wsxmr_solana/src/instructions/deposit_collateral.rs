use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use crate::state::{GlobalState, Vault};

#[derive(Accounts)]
pub struct DepositCollateral<'info> {
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
    
    #[account(
        mut,
        constraint = lp.key() == vault.lp_address @ crate::error::ErrorCode::Unauthorized
    )]
    pub lp: Signer<'info>,
    
    pub token_program: Program<'info, Token>,
}

pub fn handler(ctx: Context<DepositCollateral>, amount: u64) -> Result<()> {
    let vault = &mut ctx.accounts.vault;
    
    let transfer_ctx = CpiContext::new(
        ctx.accounts.token_program.to_account_info(),
        Transfer {
            from: ctx.accounts.lp_collateral_account.to_account_info(),
            to: ctx.accounts.vault_collateral_account.to_account_info(),
            authority: ctx.accounts.lp.to_account_info(),
        },
    );
    token::transfer(transfer_ctx, amount)?;
    
    vault.collateral_amount = vault.collateral_amount
        .checked_add(amount)
        .ok_or(error!(crate::error::ErrorCode::MathOverflow))?;
    
    if vault.lp_principal == 0 {
        vault.lp_principal = amount;
    }
    
    msg!("Deposited {} collateral to vault", amount);
    msg!("New collateral amount: {}", vault.collateral_amount);
    
    Ok(())
}
