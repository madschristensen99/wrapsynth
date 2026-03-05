use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Burn};
use crate::state::{GlobalState, Vault, BurnRequest, BurnStatus};
use crate::error::ErrorCode;

#[derive(Accounts)]
#[instruction(wsxmr_amount: u64, secret_hash: [u8; 32])]
pub struct RequestBurn<'info> {
    #[account(
        init,
        payer = user,
        space = BurnRequest::LEN,
        seeds = [
            BurnRequest::SEED_PREFIX,
            &secret_hash
        ],
        bump
    )]
    pub burn_request: Account<'info, BurnRequest>,
    
    #[account(
        mut,
        constraint = vault.active @ ErrorCode::VaultNotActive
    )]
    pub vault: Account<'info, Vault>,
    
    #[account(
        seeds = [GlobalState::SEED_PREFIX],
        bump
    )]
    pub global_state: Account<'info, GlobalState>,
    
    #[account(
        mut,
        constraint = wsxmr_mint.key() == global_state.wsxmr_mint
    )]
    pub wsxmr_mint: Account<'info, Mint>,
    
    #[account(
        mut,
        constraint = user_token_account.mint == wsxmr_mint.key(),
        constraint = user_token_account.owner == user.key()
    )]
    pub user_token_account: Account<'info, TokenAccount>,
    
    #[account(mut)]
    pub user: Signer<'info>,
    
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    pub clock: Sysvar<'info, Clock>,
}

pub fn handler(
    ctx: Context<RequestBurn>,
    wsxmr_amount: u64,
    secret_hash: [u8; 32],
) -> Result<()> {
    let burn_request = &mut ctx.accounts.burn_request;
    let vault = &mut ctx.accounts.vault;
    let clock = &ctx.accounts.clock;
    
    require!(
        ctx.accounts.user_token_account.amount >= wsxmr_amount,
        ErrorCode::InsufficientCollateral
    );
    
    let burn_ctx = CpiContext::new(
        ctx.accounts.token_program.to_account_info(),
        Burn {
            mint: ctx.accounts.wsxmr_mint.to_account_info(),
            from: ctx.accounts.user_token_account.to_account_info(),
            authority: ctx.accounts.user.to_account_info(),
        },
    );
    token::burn(burn_ctx, wsxmr_amount)?;
    
    burn_request.request_id = secret_hash;
    burn_request.user = ctx.accounts.user.key();
    burn_request.lp_vault = vault.key();
    burn_request.wsxmr_amount = wsxmr_amount;
    burn_request.locked_collateral = 0;
    burn_request.reward_collateral = 0;
    burn_request.secret_hash = secret_hash;
    burn_request.deadline = clock.unix_timestamp + crate::constants::BURN_TIMEOUT;
    burn_request.set_status(BurnStatus::Requested);
    
    msg!("Burn request created");
    msg!("Amount: {}, Deadline: {}", wsxmr_amount, burn_request.deadline);
    
    Ok(())
}
