use anchor_lang::prelude::*;
use crate::state::{BurnRequest, BurnStatus};
use crate::error::ErrorCode;

#[derive(Accounts)]
pub struct CommitBurn<'info> {
    #[account(
        mut,
        constraint = burn_request.get_status() == BurnStatus::Proposed @ ErrorCode::InvalidRequestStatus,
        constraint = burn_request.user == user.key() @ ErrorCode::Unauthorized
    )]
    pub burn_request: Account<'info, BurnRequest>,
    
    pub user: Signer<'info>,
}

pub fn handler(ctx: Context<CommitBurn>) -> Result<()> {
    let burn_request = &mut ctx.accounts.burn_request;
    
    burn_request.set_status(BurnStatus::Committed);
    
    msg!("Burn committed by user");
    msg!("LP must reveal secret before deadline: {}", burn_request.deadline);
    
    Ok(())
}
