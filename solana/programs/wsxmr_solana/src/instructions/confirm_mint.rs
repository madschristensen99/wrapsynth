use anchor_lang::prelude::*;
use crate::state::{Vault, MintRequest, MintStatus};
use crate::error::ErrorCode;

#[derive(Accounts)]
pub struct ConfirmMint<'info> {
    #[account(
        mut,
        constraint = mint_request.lp_vault == vault.key(),
        constraint = mint_request.get_status() == MintStatus::Pending @ ErrorCode::InvalidRequestStatus
    )]
    pub mint_request: Account<'info, MintRequest>,
    
    #[account(
        constraint = vault.lp_address == lp.key() @ ErrorCode::Unauthorized
    )]
    pub vault: Account<'info, Vault>,
    
    pub lp: Signer<'info>,
}

pub fn handler(ctx: Context<ConfirmMint>) -> Result<()> {
    let mint_request = &mut ctx.accounts.mint_request;
    
    mint_request.set_status(MintStatus::Ready);
    
    msg!("Mint request confirmed by LP");
    msg!("Request ID: {:?}", mint_request.request_id);
    
    Ok(())
}
