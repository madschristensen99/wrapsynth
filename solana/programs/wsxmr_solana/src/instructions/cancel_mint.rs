use anchor_lang::prelude::*;
use crate::state::{Vault, MintRequest, MintStatus};
use crate::error::ErrorCode;

#[derive(Accounts)]
pub struct CancelMint<'info> {
    #[account(
        mut,
        constraint = mint_request.get_status() == MintStatus::Pending @ ErrorCode::InvalidRequestStatus
    )]
    pub mint_request: Account<'info, MintRequest>,
    
    #[account(mut)]
    pub vault: Account<'info, Vault>,
    
    #[account(
        mut,
        constraint = user.key() == mint_request.initiator @ ErrorCode::Unauthorized
    )]
    pub user: Signer<'info>,
    
    /// CHECK: LP receives griefing deposit
    #[account(
        mut,
        constraint = lp.key() == vault.lp_address
    )]
    pub lp: UncheckedAccount<'info>,
    
    pub clock: Sysvar<'info, Clock>,
}

pub fn handler(ctx: Context<CancelMint>) -> Result<()> {
    let mint_request = &mut ctx.accounts.mint_request;
    let vault = &mut ctx.accounts.vault;
    let clock = &ctx.accounts.clock;
    
    require!(
        clock.unix_timestamp >= mint_request.timeout,
        ErrorCode::DeadlineNotReached
    );
    
    let total_amount = mint_request.wsxmr_amount
        .checked_add(mint_request.fee_amount)
        .ok_or(error!(ErrorCode::MathOverflow))?;
    
    vault.pending_debt = vault.pending_debt
        .checked_sub(total_amount)
        .ok_or(error!(ErrorCode::MathOverflow))?;
    
    **mint_request.to_account_info().try_borrow_mut_lamports()? = mint_request
        .to_account_info()
        .lamports()
        .checked_sub(mint_request.griefing_deposit)
        .ok_or(error!(ErrorCode::MathOverflow))?;
    
    **ctx.accounts.lp.to_account_info().try_borrow_mut_lamports()? = ctx.accounts.lp
        .to_account_info()
        .lamports()
        .checked_add(mint_request.griefing_deposit)
        .ok_or(error!(ErrorCode::MathOverflow))?;
    
    mint_request.set_status(MintStatus::Cancelled);
    
    msg!("Mint request cancelled");
    msg!("Griefing deposit transferred to LP");
    
    Ok(())
}
