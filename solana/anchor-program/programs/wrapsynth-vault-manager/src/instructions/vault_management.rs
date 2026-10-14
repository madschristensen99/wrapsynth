use anchor_lang::prelude::*;
use anchor_spl::token_2022::{transfer_checked, Token2022, TransferChecked};
use anchor_spl::token_interface::{Mint, TokenAccount};

use crate::constants::*;
use crate::errors::WrapSynthError;
use crate::state::{GlobalState, Vault};
use crate::utils::{check_collateral_ratio, get_collateral_price, get_xmr_price};

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
    vault.active_burn_count = 0;
    vault.pending_mint_count = 0;
    vault.mint_timeout_seconds = DEFAULT_MINT_TIMEOUT_SECONDS;
    vault.burn_timeout_seconds = DEFAULT_BURN_TIMEOUT_SECONDS;
    vault.whitelisted_minters = [Pubkey::default(); MAX_WHITELISTED_MINTERS];
    vault.whitelisted_minter_count = 0;
    vault.deployed_collateral = 0;
    vault.max_co_lp_range_bps = DEFAULT_CO_LP_RANGE_BPS;
    vault.active = true;
    vault.bump = ctx.bumps.vault;

    msg!("Vault created for LP: {}", ctx.accounts.lp.key());
    Ok(())
}

// ─── deposit_collateral ──────────────────────────────────────────────────────
// Raw QQQx deposit (equivalent to depositSDAI in VaultManager.sol). No yield
// wrapper: the amount transferred is the amount tracked 1:1.

pub fn deposit_collateral(ctx: Context<DepositCollateral>, amount: u64) -> Result<()> {
    require!(amount > 0, WrapSynthError::ZeroAmount);

    let vault = &mut ctx.accounts.vault;
    require!(vault.active, WrapSynthError::VaultNotActive);

    // Transfer collateral from LP to vault ATA
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

    msg!(
        "Deposited {} collateral into vault {}",
        amount,
        ctx.accounts.lp.key()
    );
    Ok(())
}

// ─── withdraw_collateral ─────────────────────────────────────────────────────

pub fn withdraw_collateral(ctx: Context<WithdrawCollateral>, amount: u64) -> Result<()> {
    require!(amount > 0, WrapSynthError::ZeroAmount);

    let vault = &mut ctx.accounts.vault;
    require!(vault.active, WrapSynthError::VaultNotActive);
    // Block withdrawals while READY mints are pending — the par lock must stay
    // reserved until the mint is finalized or cancelled (EVM parity).
    require!(
        vault.pending_mint_count == 0,
        WrapSynthError::PendingMintLock
    );

    let xmr_price = get_xmr_price(&ctx.accounts.pyth_xmr, PRICE_MAX_AGE)?;
    let col_price = get_collateral_price(
        &ctx.accounts.pyth_collateral,
        PRICE_MAX_AGE,
        &QQQX_USD_FEED_ID,
    )?;

    // Cannot withdraw locked collateral
    let available = vault
        .collateral_amount
        .checked_sub(vault.locked_collateral)
        .ok_or(WrapSynthError::InsufficientCollateral)?;
    require!(available >= amount, WrapSynthError::InsufficientCollateral);

    let new_collateral = vault.collateral_amount - amount;

    // Health check after withdrawal
    let global = &ctx.accounts.global_state.load()?;
    let actual_debt =
        crate::utils::math::get_actual_debt(vault.normalized_debt, global.global_debt_index);
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

    msg!("Withdrew {} collateral from vault {}", amount, lp_key);
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
    require!(
        (max_mint_bps as u64) <= BPS_DENOMINATOR,
        WrapSynthError::InvalidValue
    );
    ctx.accounts.vault.max_mint_bps = max_mint_bps;
    Ok(())
}

pub fn set_min_burn_amount(ctx: Context<UpdateVaultConfig>, min_amount: u64) -> Result<()> {
    ctx.accounts.vault.min_burn_amount = min_amount;
    Ok(())
}

pub fn set_mint_timeout(ctx: Context<UpdateVaultConfig>, seconds: i64) -> Result<()> {
    require!(
        seconds >= MIN_MINT_TIMEOUT_SECONDS && seconds <= MAX_MINT_TIMEOUT_SECONDS,
        WrapSynthError::InvalidConfig
    );
    ctx.accounts.vault.mint_timeout_seconds = seconds;
    Ok(())
}

pub fn set_burn_timeout(ctx: Context<UpdateVaultConfig>, seconds: i64) -> Result<()> {
    require!(
        seconds >= MIN_BURN_TIMEOUT_SECONDS && seconds <= MAX_BURN_TIMEOUT_SECONDS,
        WrapSynthError::InvalidConfig
    );
    ctx.accounts.vault.burn_timeout_seconds = seconds;
    Ok(())
}

pub fn set_minter_whitelist(
    ctx: Context<UpdateVaultConfig>,
    minter: Pubkey,
    whitelisted: bool,
) -> Result<()> {
    require!(minter != Pubkey::default(), WrapSynthError::ZeroAddress);
    set_minter_whitelist_internal(&mut ctx.accounts.vault, minter, whitelisted)?;
    msg!("Minter whitelist updated: {} → {}", minter, whitelisted);
    Ok(())
}

fn set_minter_whitelist_internal(
    vault: &mut Vault,
    minter: Pubkey,
    whitelisted: bool,
) -> Result<()> {
    let count = vault.whitelisted_minter_count as usize;
    let mut idx = None;
    for i in 0..count {
        if vault.whitelisted_minters[i] == minter {
            idx = Some(i);
            break;
        }
    }

    if whitelisted {
        if idx.is_none() {
            require!(
                count < MAX_WHITELISTED_MINTERS,
                WrapSynthError::MaxVaultsReached
            );
            vault.whitelisted_minters[count] = minter;
            vault.whitelisted_minter_count = (count + 1) as u32;
        }
    } else if let Some(i) = idx {
        // Swap-remove
        let last = count - 1;
        if i != last {
            vault.whitelisted_minters[i] = vault.whitelisted_minters[last];
        }
        vault.whitelisted_minters[last] = Pubkey::default();
        vault.whitelisted_minter_count = last as u32;
    }
    Ok(())
}

pub fn batch_set_minter_whitelist(
    ctx: Context<UpdateVaultConfig>,
    minters: Vec<Pubkey>,
    whitelisted: bool,
) -> Result<()> {
    for minter in minters {
        require!(minter != Pubkey::default(), WrapSynthError::ZeroAddress);
        set_minter_whitelist_internal(&mut ctx.accounts.vault, minter, whitelisted)?;
    }
    Ok(())
}

pub fn deactivate_vault(ctx: Context<DeactivateVault>) -> Result<()> {
    let vault = &mut ctx.accounts.vault;
    require!(vault.active, WrapSynthError::VaultNotActive);
    require!(vault.normalized_debt == 0, WrapSynthError::InsufficientDebt);
    require!(
        vault.collateral_amount == 0,
        WrapSynthError::InsufficientCollateral
    );
    require!(
        vault.active_burn_count == 0,
        WrapSynthError::UnresolvedBurns
    );
    vault.active = false;
    msg!("Vault deactivated: {}", ctx.accounts.lp.key());
    Ok(())
}

// ─── Internal: slash collateral to the program pool ─────────────────────────

/// Physically move slashed collateral from a vault ATA to the program
/// collateral pool ATA. Called at credit time whenever collateral is owed to a
/// PendingReturns account so the pool is always fully backed.
/// The vault PDA signs the transfer.
pub fn slash_to_pool<'a>(
    vault: &Vault,
    vault_info: &AccountInfo<'a>,
    vault_collateral_ata: &AccountInfo<'a>,
    program_collateral_ata: &AccountInfo<'a>,
    collateral_mint: &AccountInfo<'a>,
    token_program: &AccountInfo<'a>,
    decimals: u8,
    amount: u64,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    let lp_key = vault.lp_address;
    let seeds: &[&[u8]] = &[VAULT_SEED, lp_key.as_ref(), &[vault.bump]];
    let signer_seeds = &[seeds];
    let cpi_ctx = CpiContext::new_with_signer(
        token_program.clone(),
        TransferChecked {
            from: vault_collateral_ata.clone(),
            mint: collateral_mint.clone(),
            to: program_collateral_ata.clone(),
            authority: vault_info.clone(),
        },
        signer_seeds,
    );
    transfer_checked(cpi_ctx, amount, decimals)
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
    pub vault: Box<Account<'info, Vault>>,

    #[account(
        mut,
        seeds = [GLOBAL_STATE_SEED],
        bump,
    )]
    pub global_state: AccountLoader<'info, GlobalState>,

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
    pub vault: Box<Account<'info, Vault>>,

    #[account(
        mut,
        seeds = [GLOBAL_STATE_SEED],
        bump,
    )]
    pub global_state: AccountLoader<'info, GlobalState>,

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

    pub token_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
}

// ─── initialize_vault_collateral ─────────────────────────────────────────────

pub fn initialize_vault_collateral(ctx: Context<InitializeVaultCollateral>) -> Result<()> {
    msg!(
        "Vault collateral ATA initialized for vault: {}",
        ctx.accounts.vault.key()
    );
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
    pub vault: Box<Account<'info, Vault>>,

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
    pub vault: Box<Account<'info, Vault>>,

    #[account(
        mut,
        seeds = [GLOBAL_STATE_SEED],
        bump,
    )]
    pub global_state: AccountLoader<'info, GlobalState>,

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

    /// CHECK: Pyth XMR/USD price feed — validated by oracle.rs
    pub pyth_xmr: AccountInfo<'info>,
    /// CHECK: Pyth QQQX/USD price feed — validated by oracle.rs
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
    pub vault: Box<Account<'info, Vault>>,
}

#[derive(Accounts)]
pub struct DeactivateVault<'info> {
    #[account(mut)]
    pub lp: Signer<'info>,

    #[account(
        mut,
        seeds = [VAULT_SEED, lp.key().as_ref()],
        bump = vault.bump,
        constraint = vault.lp_address == lp.key() @ WrapSynthError::Unauthorized,
    )]
    pub vault: Box<Account<'info, Vault>>,

    #[account(
        mut,
        seeds = [GLOBAL_STATE_SEED],
        bump,
    )]
    pub global_state: AccountLoader<'info, GlobalState>,
}
