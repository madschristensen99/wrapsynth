use anchor_lang::prelude::*;
use crate::state::{Vault, BurnRequest, BurnStatus};
use crate::error::ErrorCode;

#[derive(Accounts)]
pub struct CancelBurn<'info> {
    #[account(
        mut,
        constraint = burn_request.get_status() == BurnStatus::Requested @ ErrorCode::InvalidRequestStatus,
        constraint = burn_request.user == user.key() @ ErrorCode::Unauthorized
    )]
    pub burn_request: Account<'info, BurnRequest>,
    
    #[account(mut)]
    pub vault: Account<'info, Vault>,
    
    pub user: Signer<'info>,
}

pub fn handler(ctx: Context<CancelBurn>) -> Result<()> {
    let burn_request = &mut ctx.accounts.burn_request;
    
    burn_request.set_status(BurnStatus::Cancelled);
    
    msg!("Burn request cancelled by user");
    
    Ok(())
}
