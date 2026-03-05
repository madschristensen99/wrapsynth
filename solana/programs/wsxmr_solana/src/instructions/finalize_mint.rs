use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, MintTo};
use crate::state::{GlobalState, Vault, MintRequest, MintStatus};
use crate::error::ErrorCode;

#[derive(Accounts)]
pub struct FinalizeMint<'info> {
    #[account(
        mut,
        constraint = mint_request.get_status() == MintStatus::Ready @ ErrorCode::InvalidRequestStatus
    )]
    pub mint_request: Account<'info, MintRequest>,
    
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
        constraint = wsxmr_mint.key() == global_state.wsxmr_mint
    )]
    pub wsxmr_mint: Account<'info, Mint>,
    
    #[account(
        mut,
        constraint = recipient_token_account.mint == wsxmr_mint.key(),
        constraint = recipient_token_account.owner == mint_request.recipient
    )]
    pub recipient_token_account: Account<'info, TokenAccount>,
    
    #[account(
        mut,
        constraint = lp_token_account.mint == wsxmr_mint.key(),
        constraint = lp_token_account.owner == vault.lp_address
    )]
    pub lp_token_account: Account<'info, TokenAccount>,
    
    /// CHECK: PDA used as mint authority
    #[account(
        seeds = [b"mint_authority"],
        bump = global_state.mint_authority_bump
    )]
    pub mint_authority: UncheckedAccount<'info>,
    
    #[account(mut)]
    pub user: Signer<'info>,
    
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<FinalizeMint>, secret: [u8; 32]) -> Result<()> {
    let mint_request = &mut ctx.accounts.mint_request;
    let vault = &mut ctx.accounts.vault;
    let global_state = &ctx.accounts.global_state;
    
    let is_valid = crate::utils::verify_secret_commitment(
        &secret,
        &mint_request.claim_commitment,
    )?;
    
    require!(is_valid, ErrorCode::InvalidSecret);
    
    let mint_authority_seeds = &[
        b"mint_authority".as_ref(),
        &[global_state.mint_authority_bump],
    ];
    let signer_seeds = &[&mint_authority_seeds[..]];
    
    let mint_to_recipient_ctx = CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        MintTo {
            mint: ctx.accounts.wsxmr_mint.to_account_info(),
            to: ctx.accounts.recipient_token_account.to_account_info(),
            authority: ctx.accounts.mint_authority.to_account_info(),
        },
        signer_seeds,
    );
    token::mint_to(mint_to_recipient_ctx, mint_request.wsxmr_amount)?;
    
    if mint_request.fee_amount > 0 {
        let mint_to_lp_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            MintTo {
                mint: ctx.accounts.wsxmr_mint.to_account_info(),
                to: ctx.accounts.lp_token_account.to_account_info(),
                authority: ctx.accounts.mint_authority.to_account_info(),
            },
            signer_seeds,
        );
        token::mint_to(mint_to_lp_ctx, mint_request.fee_amount)?;
    }
    
    let total_minted = mint_request.wsxmr_amount
        .checked_add(mint_request.fee_amount)
        .ok_or(error!(ErrorCode::MathOverflow))?;
    
    vault.pending_debt = vault.pending_debt
        .checked_sub(total_minted)
        .ok_or(error!(ErrorCode::MathOverflow))?;
    
    let normalized_debt_increase = (total_minted as u128)
        .checked_mul(GlobalState::DEBT_INDEX_PRECISION as u128)
        .ok_or(error!(ErrorCode::MathOverflow))?
        .checked_div(global_state.global_debt_index as u128)
        .ok_or(error!(ErrorCode::MathOverflow))?;
    
    vault.normalized_debt = vault.normalized_debt
        .checked_add(normalized_debt_increase as u64)
        .ok_or(error!(ErrorCode::MathOverflow))?;
    
    **mint_request.to_account_info().try_borrow_mut_lamports()? = mint_request
        .to_account_info()
        .lamports()
        .checked_sub(mint_request.griefing_deposit)
        .ok_or(error!(ErrorCode::MathOverflow))?;
    
    **ctx.accounts.user.to_account_info().try_borrow_mut_lamports()? = ctx.accounts.user
        .to_account_info()
        .lamports()
        .checked_add(mint_request.griefing_deposit)
        .ok_or(error!(ErrorCode::MathOverflow))?;
    
    mint_request.set_status(MintStatus::Completed);
    
    msg!("Mint finalized");
    msg!("Minted {} wsXMR to recipient", mint_request.wsxmr_amount);
    msg!("Fee {} wsXMR to LP", mint_request.fee_amount);
    
    Ok(())
}
