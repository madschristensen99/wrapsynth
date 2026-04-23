use anchor_lang::prelude::*;
use anchor_spl::token_2022::{self, Token2022, InitializeMint2};
use anchor_spl::token_interface::Mint;

use crate::constants::*;
use crate::errors::WrapSynthError;
use crate::state::GlobalState;

/// Initialize the protocol: create GlobalState PDA and wsXMR Token 2022 mint.
/// Equivalent to VaultManager constructor.
pub fn handler(
    ctx: Context<Initialize>,
    pyth_xmr_feed: Pubkey,
    pyth_collateral_feed: Pubkey,
    collateral_mint: Pubkey,
) -> Result<()> {
    require!(pyth_xmr_feed != Pubkey::default(), WrapSynthError::ZeroAddress);
    require!(pyth_collateral_feed != Pubkey::default(), WrapSynthError::ZeroAddress);
    require!(collateral_mint != Pubkey::default(), WrapSynthError::ZeroAddress);

    let global = &mut ctx.accounts.global_state;
    global.authority = ctx.accounts.authority.key();
    global.wsxmr_mint = ctx.accounts.wsxmr_mint.key();
    global.collateral_mint = collateral_mint;
    global.liquidity_router = Pubkey::default(); // Set later via set_liquidity_router
    global.pyth_xmr_feed = pyth_xmr_feed;
    global.pyth_collateral_feed = pyth_collateral_feed;
    global.global_total_debt = 0;
    global.global_debt_index = INITIAL_DEBT_INDEX;
    global.yield_war_chest = 0;
    global.global_lp_principal = 0;
    global.global_lp_principal_shares = 0;
    global.global_pending_collateral = 0;
    global.global_pending_sol = 0;
    global.global_bad_debt = 0;
    global.global_pending_burn_debt = 0;
    global.last_buy_timestamp = 0;
    global.vault_count = 0;
    global.request_nonce = 0;
    global.bump = ctx.bumps.global_state;

    // Initialize wsXMR mint with 8 decimals.
    // Mint authority and freeze authority = vault_manager program (via PDA).
    let bump = ctx.bumps.global_state;
    let seeds: &[&[u8]] = &[GLOBAL_STATE_SEED, &[bump]];
    let signer_seeds = &[seeds];

    let cpi_ctx = CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        InitializeMint2 {
            mint: ctx.accounts.wsxmr_mint.to_account_info(),
        },
        signer_seeds,
    );
    token_2022::initialize_mint2(
        cpi_ctx,
        8, // decimals — matches wsXMR.sol
        &global.key(),
        Some(&global.key()),
    )?;

    msg!("WrapSynth initialized. wsXMR mint: {}", ctx.accounts.wsxmr_mint.key());
    Ok(())
}

/// Set the liquidity router — one-time, deployer only.
/// Equivalent to setLiquidityRouter in VaultManager.sol.
pub fn set_liquidity_router(ctx: Context<SetLiquidityRouter>, router: Pubkey) -> Result<()> {
    let global = &mut ctx.accounts.global_state;
    require!(
        ctx.accounts.authority.key() == global.authority,
        WrapSynthError::OnlyDeployer
    );
    require!(global.liquidity_router == Pubkey::default(), WrapSynthError::RouterAlreadySet);
    require!(router != Pubkey::default(), WrapSynthError::ZeroAddress);
    global.liquidity_router = router;
    msg!("Liquidity router set: {}", router);
    Ok(())
}

// ─── Accounts ────────────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        init,
        payer = authority,
        space = GlobalState::LEN,
        seeds = [GLOBAL_STATE_SEED],
        bump,
    )]
    pub global_state: Account<'info, GlobalState>,

    /// wsXMR Token 2022 mint — allocated by caller, initialized by this instruction.
    /// seeds = [WSXMR_MINT_SEED] so the program controls the address.
    #[account(
        init,
        payer = authority,
        seeds = [WSXMR_MINT_SEED],
        bump,
        mint::decimals = 8,
        mint::authority = global_state,
        mint::freeze_authority = global_state,
        mint::token_program = token_program,
    )]
    pub wsxmr_mint: InterfaceAccount<'info, Mint>,

    pub token_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct SetLiquidityRouter<'info> {
    pub authority: Signer<'info>,
    #[account(
        mut,
        seeds = [GLOBAL_STATE_SEED],
        bump = global_state.bump,
    )]
    pub global_state: Account<'info, GlobalState>,
}
