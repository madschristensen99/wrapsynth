use anchor_lang::prelude::*;
use anchor_lang::system_program::{CreateAccount, create_account};
use anchor_spl::token_2022::{self, Token2022, InitializeMint2};

use crate::constants::*;
use crate::errors::WrapSynthError;
use crate::state::GlobalState;

/// Initialize the protocol: create GlobalState PDA and wsXMR Token-2022 mint.
///
/// NOTE: We allocate + initialize the wsXMR mint manually (create_account CPI then
/// initialize_mint2 CPI) instead of using Anchor's `init` + `mint::*` constraints on
/// InterfaceAccount<Mint>. Anchor 0.30 with Token-2022 calls InitializeMint2 twice when
/// those constraints are used (once from the constraint framework, once from mint:: helper),
/// causing error 0x6 ("account already in use"). The manual approach avoids this.
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
    global.liquidity_router = Pubkey::default();
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

    // ── Mint allocation: SystemProgram::create_account ─────────────────────────
    let mint_bump = ctx.bumps.wsxmr_mint;
    let mint_seeds: &[&[u8]] = &[WSXMR_MINT_SEED, &[mint_bump]];
    let mint_signer = &[mint_seeds];

    // Token-2022 base Mint is 82 bytes (same as spl-token Mint, no extensions).
    let mint_space: u64 = 82;
    let mint_rent = Rent::get()?.minimum_balance(mint_space as usize);

    create_account(
        CpiContext::new_with_signer(
            ctx.accounts.system_program.to_account_info(),
            CreateAccount {
                from: ctx.accounts.authority.to_account_info(),
                to:   ctx.accounts.wsxmr_mint.to_account_info(),
            },
            mint_signer,
        ),
        mint_rent,
        mint_space,
        ctx.accounts.token_program.key,
    )?;

    // ── Mint initialization: Token-2022 initialize_mint2 ──────────────────────
    let global_key = ctx.accounts.global_state.key();
    token_2022::initialize_mint2(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            InitializeMint2 { mint: ctx.accounts.wsxmr_mint.to_account_info() },
        ),
        8,              // decimals
        &global_key,    // mint authority = GlobalState PDA
        Some(&global_key),
    )?;

    msg!("WrapSynth initialized. wsXMR mint: {}", ctx.accounts.wsxmr_mint.key());
    Ok(())
}

/// Set the liquidity router — one-time, deployer only.
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

    /// wsXMR Token-2022 mint PDA. Allocated and initialized manually in handler
    /// to avoid Anchor 0.30 double-init bug with InterfaceAccount<Mint> + Token-2022.
    #[account(
        mut,
        seeds = [WSXMR_MINT_SEED],
        bump,
    )]
    /// CHECK: allocated and initialized as a Token-2022 mint inside the handler
    pub wsxmr_mint: UncheckedAccount<'info>,

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
