use anchor_lang::prelude::*;
use anchor_spl::token_2022::{Token2022, TransferChecked, transfer_checked};
use anchor_spl::token_interface::{Mint, TokenAccount};

use crate::constants::*;
use crate::errors::WrapSynthError;
use crate::state::{GlobalState, Vault};
use crate::utils::{
    get_collateral_price, get_xmr_price, calculate_extractable_yield,
    check_collateral_ratio, collateral_to_usd,
};

// ─── create_vault ────────────────────────────────────────────────────────────

pub fn create_vault(ctx: Context<CreateVault>) -> Result<()> {
    let vault = &mut ctx.accounts.vault;
    require!(!vault.active, WrapSynthError::VaultAlreadyExists);

    vault.lp_address = ctx.accounts.lp.key();
    vault.collateral_amount = 0;
    vault.locked_collateral = 0;
    vault.normalized_debt = 0;
    vault.pending_debt = 0;
    vault.max_mint_bps = 0;
    vault.mint_griefing_deposit = 0;
    vault.mint_fee_bps = 0;
    vault.burn_reward_bps = 0;
    vault.liquidation_nonce = 0;
    vault.mint_nonce = 0;
    vault.min_burn_amount = 0;
    vault.principal_deposits = 0;
    vault.principal_shares = 0;
    vault.active_burn_count = 0;
    vault.active = true;
    vault.bump = ctx.bumps.vault;

    ctx.accounts.global_state.vault_count = ctx
        .accounts
        .global_state
        .vault_count
        .checked_add(1)
        .ok_or(WrapSynthError::MathOverflow)?;

    msg!("Vault created for LP: {}", ctx.accounts.lp.key());
    Ok(())
}

// ─── deposit_collateral_shares ───────────────────────────────────────────────
// Direct receipt-token deposit (equivalent to depositSDAI in VaultManager.sol).

pub fn deposit_collateral_shares(ctx: Context<DepositCollateral>, amount: u64) -> Result<()> {
    require!(amount > 0, WrapSynthError::ZeroAmount);

    let vault = &mut ctx.accounts.vault;
    require!(vault.active, WrapSynthError::VaultNotActive);

    // Sync yield before modifying balances
    sync_vault_yield(
        vault,
        &mut ctx.accounts.global_state,
        &ctx.accounts.pyth_xmr,
        &ctx.accounts.pyth_collateral,
    )?;

    // Transfer collateral shares from LP to vault ATA
    let cpi_ctx = CpiContext::new(
        ctx.accounts.token_program.to_account_info(),
        TransferChecked {
            from: ctx.accounts.lp_collateral_ata.to_account_info(),
            mint: ctx.accounts.collateral_mint.to_account_info(),
            to: ctx.accounts.vault_collateral_ata.to_account_info(),
            authority: ctx.accounts.lp.to_account_info(),
        },
    );
    transfer_checked(cpi_ctx, amount, ctx.accounts.collateral_mint.decimals)?;

    vault.collateral_amount = vault
        .collateral_amount
        .checked_add(amount)
        .ok_or(WrapSynthError::MathOverflow)?;
    vault.principal_shares = vault
        .principal_shares
        .checked_add(amount)
        .ok_or(WrapSynthError::MathOverflow)?;
    vault.principal_deposits = vault
        .principal_deposits
        .checked_add(amount)
        .ok_or(WrapSynthError::MathOverflow)?;

    let global = &mut ctx.accounts.global_state;
    global.global_lp_principal_shares = global
        .global_lp_principal_shares
        .checked_add(amount)
        .ok_or(WrapSynthError::MathOverflow)?;
    global.global_lp_principal = global
        .global_lp_principal
        .checked_add(amount)
        .ok_or(WrapSynthError::MathOverflow)?;

    msg!("Deposited {} collateral shares into vault {}", amount, ctx.accounts.lp.key());
    Ok(())
}

// ─── withdraw_collateral ─────────────────────────────────────────────────────

pub fn withdraw_collateral(ctx: Context<WithdrawCollateral>, amount: u64) -> Result<()> {
    require!(amount > 0, WrapSynthError::ZeroAmount);

    let vault = &mut ctx.accounts.vault;
    require!(vault.active, WrapSynthError::VaultNotActive);

    // Sync yield FIRST before reading state
    sync_vault_yield(
        vault,
        &mut ctx.accounts.global_state,
        &ctx.accounts.pyth_xmr,
        &ctx.accounts.pyth_collateral,
    )?;

    let xmr_price = get_xmr_price(&ctx.accounts.pyth_xmr, PRICE_MAX_AGE)?;
    let col_price = get_collateral_price(
        &ctx.accounts.pyth_collateral,
        PRICE_MAX_AGE,
        &ctx.accounts.global_state.pyth_collateral_feed.to_bytes(),
    )?;

    // Cannot withdraw locked collateral
    let available = vault
        .collateral_amount
        .checked_sub(vault.locked_collateral)
        .ok_or(WrapSynthError::InsufficientCollateral)?;
    require!(available >= amount, WrapSynthError::InsufficientCollateral);

    let new_collateral = vault.collateral_amount - amount;

    // Health check after withdrawal
    let global = &ctx.accounts.global_state;
    let actual_debt = crate::utils::math::get_actual_debt(vault.normalized_debt, global.global_debt_index);
    let total_obligations = actual_debt.saturating_add(vault.pending_debt);

    if total_obligations > 0 {
        let available_for_debt = new_collateral.saturating_sub(vault.locked_collateral);
        require!(
            check_collateral_ratio(
                available_for_debt,
                col_price,
                total_obligations,
                xmr_price,
                COLLATERAL_RATIO,
            ),
            WrapSynthError::InsufficientCollateral
        );
    }

    // Update principal tracking proportionally
    if vault.collateral_amount > 0 {
        let proportion = (amount as u128)
            .checked_mul(1_000_000_000_000_000_000u128)
            .unwrap_or(0)
            / vault.collateral_amount as u128;

        let principal_to_deduct = ((vault.principal_deposits as u128 * proportion)
            / 1_000_000_000_000_000_000u128) as u64;
        let shares_to_deduct = ((vault.principal_shares as u128 * proportion)
            / 1_000_000_000_000_000_000u128) as u64;

        vault.principal_deposits = vault.principal_deposits.saturating_sub(principal_to_deduct);
        vault.principal_shares = vault.principal_shares.saturating_sub(shares_to_deduct);

        let global_mut = &mut ctx.accounts.global_state;
        global_mut.global_lp_principal = global_mut.global_lp_principal.saturating_sub(principal_to_deduct);
        global_mut.global_lp_principal_shares = global_mut.global_lp_principal_shares.saturating_sub(shares_to_deduct);
    }

    vault.collateral_amount = new_collateral;

    // Transfer collateral from vault ATA to LP
    let bump = vault.bump;
    let lp_key = vault.lp_address;
    let seeds: &[&[u8]] = &[VAULT_SEED, lp_key.as_ref(), &[bump]];
    let signer_seeds = &[seeds];

    let cpi_ctx = CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        TransferChecked {
            from: ctx.accounts.vault_collateral_ata.to_account_info(),
            mint: ctx.accounts.collateral_mint.to_account_info(),
            to: ctx.accounts.lp_collateral_ata.to_account_info(),
            authority: ctx.accounts.vault.to_account_info(),
        },
        signer_seeds,
    );
    transfer_checked(cpi_ctx, amount, ctx.accounts.collateral_mint.decimals)?;

    msg!("Withdrew {} collateral shares from vault {}", amount, lp_key);
    Ok(())
}

// ─── LP configuration setters ────────────────────────────────────────────────

pub fn set_mint_griefing_deposit(ctx: Context<UpdateVaultConfig>, deposit: u64) -> Result<()> {
    ctx.accounts.vault.mint_griefing_deposit = deposit;
    Ok(())
}

pub fn set_vault_market_metrics(
    ctx: Context<UpdateVaultConfig>,
    mint_fee_bps: u16,
    burn_reward_bps: u16,
) -> Result<()> {
    require!(
        (mint_fee_bps as u64) <= MAX_MARGIN_BPS && (burn_reward_bps as u64) <= MAX_MARGIN_BPS,
        WrapSynthError::ExceedsMaxMargin
    );
    ctx.accounts.vault.mint_fee_bps = mint_fee_bps;
    ctx.accounts.vault.burn_reward_bps = burn_reward_bps;
    Ok(())
}

pub fn set_max_mint_bps(ctx: Context<UpdateVaultConfig>, max_mint_bps: u16) -> Result<()> {
    require!((max_mint_bps as u64) <= BPS_DENOMINATOR, WrapSynthError::InvalidValue);
    ctx.accounts.vault.max_mint_bps = max_mint_bps;
    Ok(())
}

pub fn set_min_burn_amount(ctx: Context<UpdateVaultConfig>, min_amount: u64) -> Result<()> {
    ctx.accounts.vault.min_burn_amount = min_amount;
    Ok(())
}

pub fn deactivate_vault(ctx: Context<DeactivateVault>) -> Result<()> {
    let vault = &mut ctx.accounts.vault;
    require!(vault.active, WrapSynthError::VaultNotActive);
    require!(vault.normalized_debt == 0, WrapSynthError::InsufficientDebt);
    require!(vault.collateral_amount == 0, WrapSynthError::InsufficientCollateral);
    require!(vault.active_burn_count == 0, WrapSynthError::UnresolvedBurns);
    vault.active = false;
    ctx.accounts.global_state.vault_count = ctx
        .accounts
        .global_state
        .vault_count
        .saturating_sub(1);
    msg!("Vault deactivated: {}", ctx.accounts.lp.key());
    Ok(())
}

// ─── Internal: sync vault yield ──────────────────────────────────────────────

pub fn sync_vault_yield(
    vault: &mut Vault,
    global: &mut GlobalState,
    pyth_xmr: &AccountInfo,
    pyth_collateral: &AccountInfo,
) -> Result<()> {
    if vault.collateral_amount == 0 {
        return Ok(());
    }

    let xmr_price = get_xmr_price(pyth_xmr, PRICE_MAX_AGE)?;
    let col_feed = global.pyth_collateral_feed.to_bytes();
    let col_price = get_collateral_price(pyth_collateral, PRICE_MAX_AGE, &col_feed)?;

    let actual_debt = crate::utils::math::get_actual_debt(vault.normalized_debt, global.global_debt_index);

    let yield_shares = calculate_extractable_yield(
        vault.collateral_amount,
        vault.locked_collateral,
        vault.principal_shares,
        actual_debt,
        vault.pending_debt,
        xmr_price,
        col_price,
    );

    if yield_shares > 0 {
        vault.collateral_amount = vault.collateral_amount.saturating_sub(yield_shares);
        global.yield_war_chest = global
            .yield_war_chest
            .checked_add(yield_shares)
            .ok_or(WrapSynthError::MathOverflow)?;
        msg!("Yield harvested: {} shares", yield_shares);
    }
    Ok(())
}

// ─── Accounts ────────────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct CreateVault<'info> {
    #[account(mut)]
    pub lp: Signer<'info>,

    #[account(
        init,
        payer = lp,
        space = Vault::LEN,
        seeds = [VAULT_SEED, lp.key().as_ref()],
        bump,
    )]
    pub vault: Account<'info, Vault>,

    #[account(
        mut,
        seeds = [GLOBAL_STATE_SEED],
        bump = global_state.bump,
    )]
    pub global_state: Account<'info, GlobalState>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct DepositCollateral<'info> {
    #[account(mut)]
    pub lp: Signer<'info>,

    #[account(
        mut,
        seeds = [VAULT_SEED, lp.key().as_ref()],
        bump = vault.bump,
        constraint = vault.lp_address == lp.key() @ WrapSynthError::Unauthorized,
    )]
    pub vault: Account<'info, Vault>,

    #[account(
        mut,
        seeds = [GLOBAL_STATE_SEED],
        bump = global_state.bump,
    )]
    pub global_state: Account<'info, GlobalState>,

    pub collateral_mint: InterfaceAccount<'info, Mint>,

    #[account(mut)]
    pub lp_collateral_ata: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        seeds = [VAULT_COLLATERAL_SEED, vault.key().as_ref()],
        bump,
        token::mint = collateral_mint,
        token::authority = vault,
    )]
    pub vault_collateral_ata: InterfaceAccount<'info, TokenAccount>,

    pub pyth_xmr: AccountInfo<'info>,
    pub pyth_collateral: AccountInfo<'info>,

    pub token_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
}

// ─── initialize_vault_collateral ─────────────────────────────────────────────

pub fn initialize_vault_collateral(ctx: Context<InitializeVaultCollateral>) -> Result<()> {
    msg!("Vault collateral ATA initialized for vault: {}", ctx.accounts.vault.key());
    Ok(())
}

#[derive(Accounts)]
pub struct InitializeVaultCollateral<'info> {
    #[account(mut)]
    pub lp: Signer<'info>,

    #[account(
        seeds = [VAULT_SEED, lp.key().as_ref()],
        bump = vault.bump,
        constraint = vault.lp_address == lp.key() @ WrapSynthError::Unauthorized,
    )]
    pub vault: Account<'info, Vault>,

    pub collateral_mint: InterfaceAccount<'info, Mint>,

    #[account(
        init,
        payer = lp,
        seeds = [VAULT_COLLATERAL_SEED, vault.key().as_ref()],
        bump,
        token::mint = collateral_mint,
        token::authority = vault,
        token::token_program = token_program,
    )]
    pub vault_collateral_ata: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct WithdrawCollateral<'info> {
    #[account(mut)]
    pub lp: Signer<'info>,

    #[account(
        mut,
        seeds = [VAULT_SEED, lp.key().as_ref()],
        bump = vault.bump,
        constraint = vault.lp_address == lp.key() @ WrapSynthError::Unauthorized,
    )]
    pub vault: Account<'info, Vault>,

    #[account(
        mut,
        seeds = [GLOBAL_STATE_SEED],
        bump = global_state.bump,
    )]
    pub global_state: Account<'info, GlobalState>,

    pub collateral_mint: InterfaceAccount<'info, Mint>,

    #[account(mut)]
    pub lp_collateral_ata: InterfaceAccount<'info, TokenAccount>,

    #[account(
        mut,
        seeds = [VAULT_COLLATERAL_SEED, vault.key().as_ref()],
        bump,
        token::mint = collateral_mint,
        token::authority = vault,
    )]
    pub vault_collateral_ata: InterfaceAccount<'info, TokenAccount>,

    pub pyth_xmr: AccountInfo<'info>,
    pub pyth_collateral: AccountInfo<'info>,

    pub token_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateVaultConfig<'info> {
    pub lp: Signer<'info>,

    #[account(
        mut,
        seeds = [VAULT_SEED, lp.key().as_ref()],
        bump = vault.bump,
        constraint = vault.lp_address == lp.key() @ WrapSynthError::Unauthorized,
        constraint = vault.active @ WrapSynthError::VaultNotActive,
    )]
    pub vault: Account<'info, Vault>,
}

#[derive(Accounts)]
pub struct DeactivateVault<'info> {
    pub lp: Signer<'info>,

    #[account(
        mut,
        seeds = [VAULT_SEED, lp.key().as_ref()],
        bump = vault.bump,
        constraint = vault.lp_address == lp.key() @ WrapSynthError::Unauthorized,
    )]
    pub vault: Account<'info, Vault>,

    #[account(
        mut,
        seeds = [GLOBAL_STATE_SEED],
        bump = global_state.bump,
    )]
    pub global_state: Account<'info, GlobalState>,
}
