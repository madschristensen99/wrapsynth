use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke_signed;
use anchor_lang::solana_program::system_instruction;
use anchor_spl::token_2022::{burn as burn_tokens, Burn as BurnCpi, Token2022};
use anchor_spl::token_interface::{Mint, TokenAccount};

use crate::constants::*;
use crate::errors::WrapSynthError;
use crate::state::{Auction, GlobalState, KickPhase, Vault};
use crate::utils::math::{
    get_actual_debt, required_lamports,
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
    // New vaults start at the minimum threshold — mintable capacity is zero
    // until the LP declares a real threshold via set_threshold.
    vault.threshold_lamports_per_wsxmr = MIN_THRESHOLD_LAMPORTS;
    vault.max_mint_wsxmr = 0;
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
    vault.kick_active = false;
    vault.frozen = false;
    vault.reauction_used = false;
    vault.last_kick_resolved = 0;
    vault.active = true;
    vault.bump = ctx.bumps.vault;

    msg!("Vault created for LP: {}", ctx.accounts.lp.key());
    Ok(())
}

// ─── deposit_collateral ──────────────────────────────────────────────────────
// Native SOL deposit (equivalent to depositSDAI in VaultManager.sol). No yield
// wrapper: the lamports transferred are tracked 1:1 in collateral_amount.
//
// Kick interaction (EVM depositCollateral parity): if the vault is in kick
// GRACE, acting proves liveness — the kick cancels and the kicker's bond is
// paid to the vault. Deposits during OPEN_DELAY/ACTIVE are allowed but do not
// cancel; deposits while FROZEN are allowed but do not unfreeze. To trigger
// the grace cancel, pass the vault's auction + bond-escrow accounts.

pub fn deposit_collateral(ctx: Context<DepositCollateral>, amount: u64) -> Result<()> {
    require!(amount > 0, WrapSynthError::ZeroAmount);

    let vault = &mut ctx.accounts.vault;
    require!(vault.active, WrapSynthError::VaultNotActive);

    // GRACE cancel — liveness proven by the deposit itself.
    cancel_kick_in_grace(
        vault,
        ctx.accounts.auction.as_mut(),
        ctx.accounts.bond_escrow.as_ref(),
        &ctx.accounts.vault_collateral_escrow,
        &ctx.accounts.system_program,
    )?;

    // Transfer SOL from LP wallet to the vault collateral escrow PDA
    // (auto-creates the account on first deposit).
    anchor_lang::system_program::transfer(
        CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            anchor_lang::system_program::Transfer {
                from: ctx.accounts.lp.to_account_info(),
                to: ctx.accounts.vault_collateral_escrow.to_account_info(),
            },
        ),
        amount,
    )?;

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

/// Shared GRACE-cancel: if the vault has an active auction still in GRACE,
/// cancel it and pay the kicker's bond into vault equity. The auction account
/// and bond escrow are optional — when absent and a kick is in grace, the
/// deposit/repay proceeds without cancelling (caller loses the cancel, not
/// the deposit). Mirrors EVM _cancelKickBondToLP.
pub fn cancel_kick_in_grace<'a>(
    vault: &mut Vault,
    auction: Option<&mut Box<Account<'a, Auction>>>,
    bond_escrow: Option<&AccountInfo<'a>>,
    vault_collateral_escrow: &AccountInfo<'a>,
    system_program: &Program<'a, System>,
) -> Result<()> {
    if !vault.kick_active {
        return Ok(());
    }
    let auction = match auction {
        Some(a) => a,
        None => return Ok(()),
    };
    require!(
        auction.vault == vault_key_for(vault),
        WrapSynthError::InvalidValue
    );
    if !auction.active || kick_phase(auction) != KickPhase::Grace {
        return Ok(());
    }
    cancel_kick_bond_to_lp(vault, auction, bond_escrow, vault_collateral_escrow, system_program)
}

/// Cancel an active auction and pay the kicker's bond into vault equity —
/// phase-agnostic (callers enforce their own phase rules). EVM
/// _cancelKickBondToLP parity.
pub fn cancel_kick_bond_to_lp<'a>(
    vault: &mut Vault,
    auction: &mut Box<Account<'a, Auction>>,
    bond_escrow: Option<&AccountInfo<'a>>,
    vault_collateral_escrow: &AccountInfo<'a>,
    system_program: &Program<'a, System>,
) -> Result<()> {
    let bond_escrow = bond_escrow.ok_or(WrapSynthError::InvalidValue)?;

    // Bond → LP: move the lamports into the vault escrow and credit equity.
    let bond = auction.bond;
    if bond > 0 {
        let vault_key = auction.vault;
        let (escrow_pda, bump) = Pubkey::find_program_address(
            &[AUCTION_BOND_SEED, vault_key.as_ref()],
            &crate::ID,
        );
        require!(bond_escrow.key() == escrow_pda, WrapSynthError::InvalidValue);
        let seeds: &[&[u8]] = &[AUCTION_BOND_SEED, vault_key.as_ref(), &[bump]];
        invoke_signed(
            &system_instruction::transfer(
                &bond_escrow.key(),
                &vault_collateral_escrow.key(),
                bond,
            ),
            &[
                bond_escrow.clone(),
                vault_collateral_escrow.clone(),
                system_program.to_account_info(),
            ],
            &[seeds],
        )?;
        vault.collateral_amount = vault
            .collateral_amount
            .checked_add(bond)
            .ok_or(WrapSynthError::MathOverflow)?;
    }

    // Close out the auction record in place (the account persists; a fresh
    // kick re-arms it via init_if_needed).
    auction.active = false;
    auction.kicker = Pubkey::default();
    auction.bond = 0;
    auction.offered_collateral = 0;
    auction.auction_opened = false;

    vault.last_kick_resolved = Clock::get()?.unix_timestamp;
    vault.kick_active = false;
    msg!("Kick cancelled by LP action (bond -> LP): {}", vault.lp_address);
    Ok(())
}

/// Current kick phase from wall-clock (EVM _kickPhase parity, slots → seconds).
pub fn kick_phase(auction: &Auction) -> KickPhase {
    let now = Clock::get().map(|c| c.unix_timestamp).unwrap_or(0);
    if now < auction.kick_time + KICK_GRACE_SECONDS {
        return KickPhase::Grace;
    }
    if now < auction.kick_time + KICK_GRACE_SECONDS + AUCTION_OPEN_DELAY_SECONDS {
        return KickPhase::OpenDelay;
    }
    if now < auction.auction_end {
        return KickPhase::Active;
    }
    KickPhase::Ended
}

/// The vault PDA key for a Vault account (seeds = [VAULT_SEED, lp_address]).
pub fn vault_key_for(vault: &Vault) -> Pubkey {
    Pubkey::find_program_address(&[VAULT_SEED, vault.lp_address.as_ref()], &crate::ID).0
}

// ─── withdraw_collateral ─────────────────────────────────────────────────────

pub fn withdraw_collateral(ctx: Context<WithdrawCollateral>, amount: u64) -> Result<()> {
    require!(amount > 0, WrapSynthError::ZeroAmount);

    let vault = &mut ctx.accounts.vault;
    require!(vault.active, WrapSynthError::VaultNotActive);
    // Blocked while a kick is active or the vault is frozen (EVM vaultNotBlocked).
    require!(!vault.kick_active, WrapSynthError::KickActive);
    require!(!vault.frozen, WrapSynthError::VaultFrozen);
    // Block withdrawals while READY mints are pending — the par lock must stay
    // reserved until the mint is finalized or cancelled (EVM parity).
    require!(
        vault.pending_mint_count == 0,
        WrapSynthError::PendingMintLock
    );

    // Cannot withdraw locked collateral
    let available = vault
        .collateral_amount
        .checked_sub(vault.locked_collateral)
        .ok_or(WrapSynthError::InsufficientCollateral)?;
    require!(available >= amount, WrapSynthError::InsufficientCollateral);

    // Post-withdrawal the vault must still cover debt+pendingDebt at its own
    // declared threshold (EVM _coverageOk parity — no price read).
    let global = &ctx.accounts.global_state.load()?;
    let actual_debt =
        get_actual_debt(vault.normalized_debt, global.global_debt_index);
    let total_obligations = actual_debt.saturating_add(vault.pending_debt);

    let new_collateral = vault.collateral_amount - amount;
    if total_obligations > 0 {
        let free_after = new_collateral.saturating_sub(vault.locked_collateral);
        require!(
            free_after >= required_lamports(total_obligations, vault.threshold_lamports_per_wsxmr),
            WrapSynthError::InsufficientCollateral
        );
    }

    vault.collateral_amount = new_collateral;

    // Transfer SOL from the vault collateral escrow PDA to the LP
    let lp_key = vault.lp_address;
    let vault_key = ctx.accounts.vault.key();
    let escrow_bump = ctx.bumps.vault_collateral_escrow;
    let seeds: &[&[u8]] = &[VAULT_COLLATERAL_SEED, vault_key.as_ref(), &[escrow_bump]];
    invoke_signed(
        &system_instruction::transfer(
            &ctx.accounts.vault_collateral_escrow.key(),
            &ctx.accounts.lp.key(),
            amount,
        ),
        &[
            ctx.accounts.vault_collateral_escrow.to_account_info(),
            ctx.accounts.lp.to_account_info(),
            ctx.accounts.system_program.to_account_info(),
        ],
        &[seeds],
    )?;

    msg!("Withdrew {} lamports from vault {}", amount, lp_key);
    Ok(())
}

// ─── repay_debt ──────────────────────────────────────────────────────────────
// LP burns wsXMR to retire vault debt. Kick interaction (EVM repayDebt parity):
//   - GRACE: any repay cancels the kick (liveness proven); bond → LP.
//   - OPEN_DELAY / ACTIVE / ENDED-unresolved: only a repay covering the FULL
//     actual debt cancels; partial repays revert.
//   - FROZEN (no active kick): repays allowed; reaching zero debt unfreezes.
// Pass the vault's auction + bond-escrow accounts when a kick is active.

pub fn repay_debt(ctx: Context<RepayDebt>, wsxmr_amount: u64) -> Result<()> {
    require!(wsxmr_amount > 0, WrapSynthError::ZeroAmount);

    let vault = &mut ctx.accounts.vault;
    require!(vault.active, WrapSynthError::VaultNotActive);

    let global_debt_index = ctx.accounts.global_state.load()?.global_debt_index;
    let debt = get_actual_debt(vault.normalized_debt, global_debt_index);
    require!(debt > 0, WrapSynthError::InsufficientDebt);

    if vault.kick_active {
        require!(
            ctx.accounts.auction.is_some(),
            WrapSynthError::InvalidValue
        );
        let auction = ctx.accounts.auction.as_mut().unwrap();
        require!(auction.active, WrapSynthError::NoActiveKick);
        require!(
            auction.vault == vault_key_for(vault),
            WrapSynthError::InvalidValue
        );
        require!(
            ctx.accounts.vault_collateral_escrow.is_some(),
            WrapSynthError::InvalidValue
        );
        if kick_phase(auction) != KickPhase::Grace {
            // Post-grace rescue: full debt only, cancels the auction outright.
            require!(wsxmr_amount == debt, WrapSynthError::InsufficientDebt);
        }
        let escrow = ctx.accounts.vault_collateral_escrow.as_ref().unwrap();
        cancel_kick_bond_to_lp(
            vault,
            auction,
            ctx.accounts.bond_escrow.as_ref(),
            escrow,
            &ctx.accounts.system_program,
        )?;
    }

    let repay_amount = wsxmr_amount.min(debt);
    burn_tokens(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            BurnCpi {
                mint: ctx.accounts.wsxmr_mint.to_account_info(),
                from: ctx.accounts.lp_wsxmr_ata.to_account_info(),
                authority: ctx.accounts.lp.to_account_info(),
            },
        ),
        repay_amount,
    )?;

    let normalized_repay = (repay_amount as u128)
        .checked_mul(DEBT_INDEX_PRECISION as u128)
        .unwrap_or(u128::MAX)
        / global_debt_index as u128;
    vault.normalized_debt = if normalized_repay as u64 > vault.normalized_debt {
        0
    } else {
        vault.normalized_debt - normalized_repay as u64
    };
    let global = &mut ctx.accounts.global_state.load_mut()?;
    global.global_total_debt = global.global_total_debt.saturating_sub(repay_amount);

    // A debt-free frozen vault is trivially solvent — unfreeze.
    if vault.frozen && vault.normalized_debt == 0 {
        vault.frozen = false;
    }

    msg!("Debt repaid on vault {}: {}", vault.lp_address, repay_amount);
    Ok(())
}

// ─── Threshold setters ───────────────────────────────────────────────────────
// Blocked while a kick is active or the vault is frozen — the threshold is
// the par-settlement rate in-flight requests snapshot, so it must be stable
// through a dispute (EVM vaultNotBlocked parity).

pub fn set_threshold(ctx: Context<UpdateVaultConfig>, threshold: u128) -> Result<()> {
    let vault = &mut ctx.accounts.vault;
    require!(!vault.kick_active, WrapSynthError::KickActive);
    require!(!vault.frozen, WrapSynthError::VaultFrozen);
    require!(
        threshold >= MIN_THRESHOLD_LAMPORTS,
        WrapSynthError::BelowMinThreshold
    );
    vault.threshold_lamports_per_wsxmr = threshold;
    Ok(())
}

pub fn set_max_mint_wsxmr(ctx: Context<UpdateVaultConfig>, max_wsxmr: u64) -> Result<()> {
    let vault = &mut ctx.accounts.vault;
    require!(!vault.kick_active, WrapSynthError::KickActive);
    require!(!vault.frozen, WrapSynthError::VaultFrozen);
    vault.max_mint_wsxmr = max_wsxmr;
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
    require!(!vault.kick_active, WrapSynthError::KickActive);
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

/// Physically move slashed collateral (lamports) from a vault escrow to the
/// program collateral pool escrow. Called at credit time whenever collateral
/// is owed to a PendingReturns account so the pool is always fully backed.
/// The vault escrow PDA signs the system transfer with its own seeds.
pub fn slash_to_pool<'a>(
    vault: &Vault,
    vault_collateral_escrow: &AccountInfo<'a>,
    collateral_escrow: &AccountInfo<'a>,
    system_program: &AccountInfo<'a>,
    amount: u64,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    let (vault_pda, _) = Pubkey::find_program_address(
        &[VAULT_SEED, vault.lp_address.as_ref()],
        &crate::ID,
    );
    let (_, escrow_bump) = Pubkey::find_program_address(
        &[VAULT_COLLATERAL_SEED, vault_pda.as_ref()],
        &crate::ID,
    );
    let seeds: &[&[u8]] = &[VAULT_COLLATERAL_SEED, vault_pda.as_ref(), &[escrow_bump]];
    invoke_signed(
        &system_instruction::transfer(
            &vault_collateral_escrow.key(),
            &collateral_escrow.key(),
            amount,
        ),
        &[
            vault_collateral_escrow.clone(),
            collateral_escrow.clone(),
            system_program.clone(),
        ],
        &[seeds],
    )?;
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

    /// CHECK: lamport-only vault collateral escrow PDA — validated by seeds
    #[account(
        mut,
        seeds = [VAULT_COLLATERAL_SEED, vault.key().as_ref()],
        bump,
    )]
    pub vault_collateral_escrow: AccountInfo<'info>,

    /// Optional auction record — pass the vault's auction PDA when a kick is
    /// active so a GRACE-phase kick is cancelled by this deposit.
    #[account(
        mut,
        seeds = [AUCTION_SEED, vault.key().as_ref()],
        bump = auction.bump,
    )]
    pub auction: Option<Box<Account<'info, Auction>>>,

    /// CHECK: optional lamport bond-escrow PDA — required when auction is passed
    #[account(
        mut,
        seeds = [AUCTION_BOND_SEED, vault.key().as_ref()],
        bump,
    )]
    pub bond_escrow: Option<AccountInfo<'info>>,

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

    /// CHECK: lamport-only vault collateral escrow PDA — validated by seeds
    #[account(
        mut,
        seeds = [VAULT_COLLATERAL_SEED, vault.key().as_ref()],
        bump,
    )]
    pub vault_collateral_escrow: AccountInfo<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RepayDebt<'info> {
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

    #[account(mut)]
    pub wsxmr_mint: InterfaceAccount<'info, Mint>,

    #[account(mut)]
    pub lp_wsxmr_ata: InterfaceAccount<'info, TokenAccount>,

    /// Optional auction record — pass when a kick is active (GRACE cancel or
    /// full-debt post-grace rescue).
    #[account(
        mut,
        seeds = [AUCTION_SEED, vault.key().as_ref()],
        bump = auction.bump,
    )]
    pub auction: Option<Box<Account<'info, Auction>>>,

    /// CHECK: optional lamport bond-escrow PDA — required when auction is passed
    #[account(
        mut,
        seeds = [AUCTION_BOND_SEED, vault.key().as_ref()],
        bump,
    )]
    pub bond_escrow: Option<AccountInfo<'info>>,

    /// CHECK: lamport-only vault collateral escrow PDA — required when auction is passed
    #[account(
        mut,
        seeds = [VAULT_COLLATERAL_SEED, vault.key().as_ref()],
        bump,
    )]
    pub vault_collateral_escrow: Option<AccountInfo<'info>>,

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
