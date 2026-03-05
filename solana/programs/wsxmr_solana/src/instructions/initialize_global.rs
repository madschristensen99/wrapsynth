use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token};
use crate::state::GlobalState;

#[derive(Accounts)]
pub struct InitializeGlobal<'info> {
    #[account(
        init,
        payer = admin,
        space = GlobalState::LEN,
        seeds = [GlobalState::SEED_PREFIX],
        bump
    )]
    pub global_state: Account<'info, GlobalState>,
    
    #[account(
        init,
        payer = admin,
        mint::decimals = crate::constants::WSXMR_DECIMALS,
        mint::authority = mint_authority,
    )]
    pub wsxmr_mint: Account<'info, Mint>,
    
    /// CHECK: PDA used as mint authority
    #[account(
        seeds = [b"mint_authority"],
        bump
    )]
    pub mint_authority: UncheckedAccount<'info>,
    
    #[account(mut)]
    pub admin: Signer<'info>,
    
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn handler(ctx: Context<InitializeGlobal>, price_max_age: u64) -> Result<()> {
    let global_state = &mut ctx.accounts.global_state;
    
    global_state.mint_authority_bump = ctx.bumps.mint_authority;
    global_state.global_debt_index = GlobalState::DEBT_INDEX_PRECISION;
    global_state.yield_war_chest = 0;
    global_state.global_lp_principal = 0;
    global_state.last_buy_timestamp = 0;
    global_state.price_max_age = price_max_age;
    global_state.wsxmr_mint = ctx.accounts.wsxmr_mint.key();
    global_state.admin = ctx.accounts.admin.key();
    
    msg!("Global state initialized with debt index: {}", GlobalState::DEBT_INDEX_PRECISION);
    msg!("wsXMR mint: {}", ctx.accounts.wsxmr_mint.key());
    
    Ok(())
}
