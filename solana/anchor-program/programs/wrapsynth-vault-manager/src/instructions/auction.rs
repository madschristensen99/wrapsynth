use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke_signed;
use anchor_lang::solana_program::system_instruction;
use anchor_spl::token_2022::{burn as burn_tokens, Burn as BurnCpi, Token2022};
use anchor_spl::token_interface::{Mint, TokenAccount};

use crate::constants::*;
use crate::errors::WrapSynthError;
use crate::instructions::vault_management::{
    cancel_kick_bond_to_lp, kick_phase, slash_to_pool, vault_key_for,
};
use crate::state::{
    Auction, BurnRequest, BurnStatus, GlobalState, KickPhase, PendingReturns, Vault,
};
use crate::utils::math::{get_actual_debt, normalize_debt, par_lamports};

// ─── kick ────────────────────────────────────────────────────────────────────
/// Kick a vault — post a bond and open the grace window. Permissionless; no
/// solvency proof required: the auction itself is the solvency test.
/// (EVM kick parity.)

pub fn kick(ctx: Context<Kick>) -> Result<()> {
    let vault = &mut ctx.accounts.vault;
    require!(vault.active, WrapSynthError::VaultNotActive);
    require!(!vault.frozen, WrapSynthError::VaultFrozen);
    require!(!vault.kick_active, WrapSynthError::KickActive);

    let clock = Clock::get()?;
    require!(
        clock.unix_timestamp >= vault.last_kick_resolved + KICK_COOLDOWN_SECONDS,
        WrapSynthError::KickOnCooldown
    );

    let global_debt_index = ctx.accounts.global_state.load()?.global_debt_index;
    require!(
        get_actual_debt(vault.normalized_debt, global_debt_index) > 0,
        WrapSynthError::InsufficientDebt
    );

    start_kick(
        vault,
        &mut ctx.accounts.auction,
        &ctx.accounts.kicker,
        &ctx.accounts.bond_escrow,
        &ctx.accounts.system_program,
        false,
    )
}

// ─── reauction ───────────────────────────────────────────────────────────────
/// Retry liquidation on a frozen vault — exactly once per vault. Clears the
/// frozen flag and starts a fresh kick. (EVM reauction parity.)

pub fn reauction(ctx: Context<Reauction>) -> Result<()> {
    let vault = &mut ctx.accounts.vault;
    require!(vault.active, WrapSynthError::VaultNotActive);
    require!(vault.frozen, WrapSynthError::InvalidStatus);
    require!(!vault.reauction_used, WrapSynthError::NoReauctionAvailable);
    require!(!vault.kick_active, WrapSynthError::KickActive);

    let clock = Clock::get()?;
    require!(
        clock.unix_timestamp >= vault.last_kick_resolved + KICK_COOLDOWN_SECONDS,
        WrapSynthError::KickOnCooldown
    );

    let global_debt_index = ctx.accounts.global_state.load()?.global_debt_index;
    require!(
        get_actual_debt(vault.normalized_debt, global_debt_index) > 0,
        WrapSynthError::InsufficientDebt
    );

    vault.reauction_used = true;
    vault.frozen = false;

    start_kick(
        vault,
        &mut ctx.accounts.auction,
        &ctx.accounts.kicker,
        &ctx.accounts.bond_escrow,
        &ctx.accounts.system_program,
        true,
    )
}

/// Pull the kick bond from the kicker into the per-vault bond-escrow PDA and
/// record the kick. EVM _startKick parity.
fn start_kick<'a>(
    vault: &mut Vault,
    auction: &mut Box<Account<'a, Auction>>,
    kicker: &Signer<'a>,
    bond_escrow: &AccountInfo<'a>,
    system_program: &Program<'a, System>,
    is_reauction: bool,
) -> Result<()> {
    let bond = ((vault.collateral_amount as u128)
        .checked_mul(KICK_BOND_BPS as u128)
        .unwrap_or(0)
        / BPS_DENOMINATOR as u128) as u64;
    let bond = bond.max(KICK_BOND_MIN_LAMPORTS);
    require!(bond > 0, WrapSynthError::InsufficientCollateral);

    // Kicker → bond escrow PDA (lamports; auto-creates the escrow account).
    anchor_lang::system_program::transfer(
        CpiContext::new(
            system_program.to_account_info(),
            anchor_lang::system_program::Transfer {
                from: kicker.to_account_info(),
                to: bond_escrow.clone(),
            },
        ),
        bond,
    )?;

    let now = Clock::get()?.unix_timestamp;
    let vault_key = vault_key_for(vault);
    auction.vault = vault_key;
    auction.kicker = kicker.key();
    auction.bond = bond;
    auction.kick_time = now;
    auction.auction_end =
        now + KICK_GRACE_SECONDS + AUCTION_OPEN_DELAY_SECONDS + AUCTION_DURATION_SECONDS;
    auction.offered_collateral = 0;
    auction.auction_opened = false;
    auction.active = true;
    auction.is_reauction = is_reauction;
    let (_, auction_bump) =
        Pubkey::find_program_address(&[AUCTION_SEED, vault_key.as_ref()], &crate::ID);
    auction.bump = auction_bump;

    vault.kick_active = true;

    msg!(
        "Kick started on vault {}: bond {} lamports, ends at {}",
        vault.lp_address,
        bond,
        auction.auction_end
    );
    Ok(())
}

// ─── resolve_burn_for_auction ────────────────────────────────────────────────
/// Resolve a single active burn on a kicked vault — permissionless, callable
/// once the grace window has elapsed (the pre-open settlement pass; each burn
/// is its own PDA so settlement is one request per call). Replaces the old
/// price-gated resolve_burn_for_liquidation — the kick replaces the solvency
/// proof.
///
/// REQUESTED/PROPOSED → re-mint wsXMR to the user.
/// COMMITTED, secret revealed → settle reward-only (lock released to vault).
/// COMMITTED, no secret → par-capped slash at threshold_at_request + reward.

pub fn resolve_burn_for_auction(ctx: Context<ResolveBurnForAuction>) -> Result<()> {
    let vault = &ctx.accounts.vault;
    let auction = &ctx.accounts.auction;
    require!(auction.active, WrapSynthError::NoActiveKick);
    require!(
        auction.vault == vault_key_for(vault),
        WrapSynthError::InvalidValue
    );
    // Burn settlement is the grace→auction transition — it cannot run while
    // the LP can still cancel.
    require!(
        kick_phase(auction) != KickPhase::Grace,
        WrapSynthError::BidNotOpen
    );

    let request = &mut ctx.accounts.burn_request;
    require!(
        request.lp_vault == ctx.accounts.vault.key(),
        WrapSynthError::InvalidBurnRequest
    );
    // Idempotency / invalidation guard: a resolved auction bumps
    // liquidation_nonce, so burns created before it must not be re-resolved.
    require!(
        request.vault_liquidation_nonce == vault.liquidation_nonce,
        WrapSynthError::BurnInvalidatedByLiquidation
    );

    let total_locked = request.locked_collateral + request.reward_collateral;

    match request.status {
        BurnStatus::Requested | BurnStatus::Proposed => {
            // LP has not yet committed XMR — re-mint wsXMR to user. Debt was NOT
            // reduced at request time, so there is nothing to restore.
            let vault = &mut ctx.accounts.vault;

            if vault.locked_collateral < total_locked {
                vault.locked_collateral = 0;
            } else {
                vault.locked_collateral -= total_locked;
            }
            vault.active_burn_count = vault.active_burn_count.saturating_sub(1);

            // Scope the RefMut so it is dropped before the CPI re-borrows the
            // global_state account data.
            let bump = {
                let global = &mut ctx.accounts.global_state.load_mut()?;
                if global.global_pending_burn_debt < request.wsxmr_amount {
                    global.global_pending_burn_debt = 0;
                } else {
                    global.global_pending_burn_debt -= request.wsxmr_amount;
                }
                global.bump
            };
            let seeds: &[&[u8]] = &[GLOBAL_STATE_SEED, &[bump]];
            let signer_seeds = &[seeds];
            let cpi_ctx = CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                anchor_spl::token_interface::MintTo {
                    mint: ctx.accounts.wsxmr_mint.to_account_info(),
                    to: ctx.accounts.user_wsxmr_ata.to_account_info(),
                    authority: ctx.accounts.global_state.to_account_info(),
                },
                signer_seeds,
            );
            anchor_spl::token_interface::mint_to(cpi_ctx, request.wsxmr_amount)?;

            request.status = BurnStatus::Cancelled;
            msg!(
                "Burn {:?} re-minted to user (pre-auction)",
                request.request_id
            );
        }
        BurnStatus::Committed => {
            if request.revealed_secret != [0u8; 32] {
                // LP already revealed — the user can claim the XMR. Settle rather
                // than slash: release the lock to the vault (seizable) and pay
                // only the reward (EVM _settleRevealedBurnLiquidation parity).
                let vault = &mut ctx.accounts.vault;
                let global = &mut ctx.accounts.global_state.load_mut()?;

                if vault.locked_collateral < total_locked {
                    vault.locked_collateral = 0;
                } else {
                    vault.locked_collateral -= total_locked;
                }

                let mut reward = request.reward_collateral;
                if vault.collateral_amount < reward {
                    reward = vault.collateral_amount;
                }
                vault.collateral_amount -= reward;

                let normalized_burn =
                    normalize_debt(request.wsxmr_amount, global.global_debt_index);
                let normalized_burn = normalized_burn.min(vault.normalized_debt);
                vault.normalized_debt -= normalized_burn;
                global.global_total_debt = global
                    .global_total_debt
                    .saturating_sub(get_actual_debt(normalized_burn, global.global_debt_index));

                if global.global_pending_burn_debt < request.wsxmr_amount {
                    global.global_pending_burn_debt = 0;
                } else {
                    global.global_pending_burn_debt -= request.wsxmr_amount;
                }

                if reward > 0 {
                    ctx.accounts.user_pending_returns.collateral_amount = ctx
                        .accounts
                        .user_pending_returns
                        .collateral_amount
                        .checked_add(reward)
                        .ok_or(WrapSynthError::MathOverflow)?;
                    global.global_pending_collateral = global
                        .global_pending_collateral
                        .checked_add(reward)
                        .ok_or(WrapSynthError::MathOverflow)?;
                    slash_to_pool(
                        vault,
                        &ctx.accounts.vault_collateral_escrow,
                        &ctx.accounts.collateral_escrow,
                        &ctx.accounts.system_program.to_account_info(),
                        reward,
                    )?;
                }

                vault.active_burn_count = vault.active_burn_count.saturating_sub(1);
                request.status = BurnStatus::Completed;
                msg!("Burn {:?} settled (revealed, auction)", request.request_id);
            } else {
                // User confirmed Monero lock, LP never revealed — par-capped
                // slash at the request's threshold snapshot: user receives
                // min(par, locked) + reward; excess returns to vault
                // (EVM _settleCommittedBurnSlash parity — no price read).
                let vault = &mut ctx.accounts.vault;
                let global = &mut ctx.accounts.global_state.load_mut()?;

                let par_collateral =
                    par_lamports(request.wsxmr_amount, request.threshold_at_request);
                let user_base = par_collateral.min(request.locked_collateral);
                let user_payout = user_base.saturating_add(request.reward_collateral);

                if vault.locked_collateral < total_locked {
                    vault.locked_collateral = 0;
                } else {
                    vault.locked_collateral -= total_locked;
                }
                if vault.collateral_amount < user_payout {
                    vault.collateral_amount = 0;
                } else {
                    vault.collateral_amount -= user_payout;
                }

                let normalized_burn =
                    normalize_debt(request.wsxmr_amount, global.global_debt_index);
                let normalized_burn = normalized_burn.min(vault.normalized_debt);
                vault.normalized_debt -= normalized_burn;
                global.global_total_debt = global
                    .global_total_debt
                    .saturating_sub(get_actual_debt(normalized_burn, global.global_debt_index));

                if global.global_pending_burn_debt < request.wsxmr_amount {
                    global.global_pending_burn_debt = 0;
                } else {
                    global.global_pending_burn_debt -= request.wsxmr_amount;
                }

                if user_payout > 0 {
                    ctx.accounts.user_pending_returns.collateral_amount = ctx
                        .accounts
                        .user_pending_returns
                        .collateral_amount
                        .checked_add(user_payout)
                        .ok_or(WrapSynthError::MathOverflow)?;
                    global.global_pending_collateral = global
                        .global_pending_collateral
                        .checked_add(user_payout)
                        .ok_or(WrapSynthError::MathOverflow)?;
                    slash_to_pool(
                        vault,
                        &ctx.accounts.vault_collateral_escrow,
                        &ctx.accounts.collateral_escrow,
                        &ctx.accounts.system_program.to_account_info(),
                        user_payout,
                    )?;
                }

                vault.active_burn_count = vault.active_burn_count.saturating_sub(1);
                request.status = BurnStatus::Slashed;
                msg!("Burn {:?} slashed to user (auction)", request.request_id);
            }
        }
        _ => return err!(WrapSynthError::InvalidStatus),
    }

    Ok(())
}

// ─── open_auction ────────────────────────────────────────────────────────────
/// Transition a kicked vault from grace into the auction — permissionless,
/// idempotent. Requires every in-flight burn resolved and co-LP positions
/// unwound (each is its own account; keepers call resolve_burn_for_auction /
/// unwind_co_lp first), then snapshots the offered collateral and bumps both
/// nonces — invalidating pending mints and future burn cancellations.
/// (EVM openAuction/_ensureAuctionOpened parity.)

pub fn open_auction(ctx: Context<OpenAuction>) -> Result<()> {
    let vault = &mut ctx.accounts.vault;
    let auction = &mut ctx.accounts.auction;
    require!(auction.active, WrapSynthError::NoActiveKick);
    require!(
        auction.vault == vault_key_for(vault),
        WrapSynthError::InvalidValue
    );
    require!(
        kick_phase(auction) != KickPhase::Grace,
        WrapSynthError::BidNotOpen
    );

    if !auction.auction_opened {
        // In-flight settlement must have run first — each burn/co-LP is its own
        // account on Solana, so keepers resolve them one at a time beforehand
        // (replaces the EVM in-line loop).
        require!(
            vault.active_burn_count == 0,
            WrapSynthError::UnresolvedBurns
        );
        require!(
            vault.deployed_collateral == 0,
            WrapSynthError::UnresolvedBurns
        );

        auction.auction_opened = true;

        vault.liquidation_nonce = vault
            .liquidation_nonce
            .checked_add(1)
            .ok_or(WrapSynthError::MathOverflow)?;
        vault.mint_nonce = vault
            .mint_nonce
            .checked_add(1)
            .ok_or(WrapSynthError::MathOverflow)?;

        // Offer = free collateral post-settlement; locked key bonds are never seizable.
        auction.offered_collateral = vault
            .collateral_amount
            .saturating_sub(vault.locked_collateral);

        msg!(
            "Auction opened on vault {}: {} lamports offered",
            vault.lp_address,
            auction.offered_collateral
        );
    }
    Ok(())
}

// ─── bid ─────────────────────────────────────────────────────────────────────
/// Bid on an active auction — burn the vault's FULL actual debt in wsXMR and
/// receive X(t)% of the offered collateral. Whole-debt bids only.
/// Clearing haircut (EVM bid parity):
///   X* ≤ KICK_SANE_BPS (80%) → wrongful kick, bond → LP
///   else                     → bond + chip → kicker

pub fn bid(ctx: Context<Bid>) -> Result<()> {
    let vault = &mut ctx.accounts.vault;
    let auction = &mut ctx.accounts.auction;
    require!(auction.active, WrapSynthError::NoActiveKick);
    require!(
        auction.vault == vault_key_for(vault),
        WrapSynthError::InvalidValue
    );
    require!(
        kick_phase(auction) == KickPhase::Active,
        WrapSynthError::BidNotOpen
    );
    require!(auction.auction_opened, WrapSynthError::BidNotOpen);

    let global_debt_index = ctx.accounts.global_state.load()?.global_debt_index;
    let debt = get_actual_debt(vault.normalized_debt, global_debt_index);
    if debt == 0 {
        // In-flight settlement cleared the vault's whole debt — nothing left to
        // liquidate. Cancel the kick; bond → LP.
        cancel_kick_bond_to_lp(
            vault,
            auction,
            Some(&ctx.accounts.bond_escrow),
            &ctx.accounts.vault_collateral_escrow,
            &ctx.accounts.system_program,
        )?;
        return Ok(());
    }

    let x_bps = current_x_bps(auction);
    let bidder_payout = (auction.offered_collateral as u128)
        .checked_mul(x_bps as u128)
        .unwrap_or(0)
        / BPS_DENOMINATOR as u128;
    let bidder_payout = bidder_payout.min(u64::MAX as u128) as u64;
    let surplus = auction.offered_collateral.saturating_sub(bidder_payout);
    let chip = ((surplus as u128)
        .checked_mul(CHIP_BPS as u128)
        .unwrap_or(0)
        / BPS_DENOMINATOR as u128) as u64;

    let total_out = bidder_payout.saturating_add(chip);
    vault.collateral_amount = vault.collateral_amount.saturating_sub(total_out);

    let wrongful = x_bps <= KICK_SANE_BPS;
    if wrongful {
        // Wrongful kick — the bond compensates the LP (credited to vault equity).
        move_bond_lamports(
            &auction.vault,
            &ctx.accounts.bond_escrow,
            &ctx.accounts.vault_collateral_escrow,
            &ctx.accounts.system_program,
            auction.bond,
        )?;
        vault.collateral_amount = vault
            .collateral_amount
            .checked_add(auction.bond)
            .ok_or(WrapSynthError::MathOverflow)?;
    } else {
        // Bond + chip → kicker. Bond lamports leave the escrow to the kicker.
        move_bond_lamports(
            &auction.vault,
            &ctx.accounts.bond_escrow,
            &ctx.accounts.kicker,
            &ctx.accounts.system_program,
            auction.bond,
        )?;
    }

    // Vault escrow → kicker (chip), → bidder (haircut share).
    transfer_from_vault_escrow(
        vault,
        &ctx.accounts.vault_collateral_escrow,
        &ctx.accounts.kicker,
        &ctx.accounts.system_program,
        chip,
    )?;
    transfer_from_vault_escrow(
        vault,
        &ctx.accounts.vault_collateral_escrow,
        &ctx.accounts.bidder,
        &ctx.accounts.system_program,
        bidder_payout,
    )?;

    // Debt cleared exactly as the old liquidate() did — full denormalized debt.
    vault.normalized_debt = 0;
    {
        let global = &mut ctx.accounts.global_state.load_mut()?;
        global.global_total_debt = global.global_total_debt.saturating_sub(debt);
    }

    // Nonces were bumped at auction open; record resolution + clear the kick.
    vault.last_kick_resolved = Clock::get()?.unix_timestamp;
    vault.kick_active = false;
    auction.active = false;
    auction.bond = 0;
    auction.offered_collateral = 0;

    // Burn the bidder's wsXMR — they paid the full debt.
    burn_tokens(
        CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            BurnCpi {
                mint: ctx.accounts.wsxmr_mint.to_account_info(),
                from: ctx.accounts.bidder_wsxmr_ata.to_account_info(),
                authority: ctx.accounts.bidder.to_account_info(),
            },
        ),
        debt,
    )?;

    msg!(
        "Auction settled on vault {}: bidder {}, debt {}, X {}bps, payout {}, wrongful {}",
        vault.lp_address,
        ctx.accounts.bidder.key(),
        debt,
        x_bps,
        bidder_payout,
        wrongful
    );
    Ok(())
}

// ─── resolve_kick ────────────────────────────────────────────────────────────
/// Resolve a no-bid auction — freeze the vault and return the bond.
/// Permissionless, callable once the auction window has fully elapsed.
/// (EVM resolveKick parity.)

pub fn resolve_kick(ctx: Context<ResolveKick>) -> Result<()> {
    let vault = &mut ctx.accounts.vault;
    let auction = &mut ctx.accounts.auction;
    require!(auction.active, WrapSynthError::NoActiveKick);
    require!(
        auction.vault == vault_key_for(vault),
        WrapSynthError::InvalidValue
    );
    require!(
        kick_phase(auction) == KickPhase::Ended,
        WrapSynthError::AuctionNotEnded
    );

    if !auction.auction_opened {
        // The auction never opened — run the open transition inline so the
        // vault lands on clean state before freezing.
        require!(
            vault.active_burn_count == 0 && vault.deployed_collateral == 0,
            WrapSynthError::UnresolvedBurns
        );
        auction.auction_opened = true;
        vault.liquidation_nonce = vault
            .liquidation_nonce
            .checked_add(1)
            .ok_or(WrapSynthError::MathOverflow)?;
        vault.mint_nonce = vault
            .mint_nonce
            .checked_add(1)
            .ok_or(WrapSynthError::MathOverflow)?;
        auction.offered_collateral = vault
            .collateral_amount
            .saturating_sub(vault.locked_collateral);
    }

    let global_debt_index = ctx.accounts.global_state.load()?.global_debt_index;
    if get_actual_debt(vault.normalized_debt, global_debt_index) == 0 {
        // In-flight settlement cleared the vault's whole debt — nothing left to
        // liquidate. Cancel the kick; bond → LP rather than freezing an
        // already-solvent vault.
        cancel_kick_bond_to_lp(
            vault,
            auction,
            Some(&ctx.accounts.bond_escrow),
            &ctx.accounts.vault_collateral_escrow,
            &ctx.accounts.system_program,
        )?;
        return Ok(());
    }

    vault.frozen = true;
    vault.last_kick_resolved = Clock::get()?.unix_timestamp;
    vault.kick_active = false;

    // Bond → kicker.
    let bond = auction.bond;
    move_bond_lamports(
        &auction.vault,
        &ctx.accounts.bond_escrow,
        &ctx.accounts.kicker,
        &ctx.accounts.system_program,
        bond,
    )?;

    auction.active = false;
    auction.bond = 0;
    auction.offered_collateral = 0;

    msg!("Vault {} frozen after inconclusive auction", vault.lp_address);
    Ok(())
}

// ─── backstop_vault ──────────────────────────────────────────────────────────
/// Backstop a frozen vault — a healthy LP assumes its debt and collateral.
/// Callable only when the vault is FROZEN (or the kick has ended unresolved,
/// which is resolved to frozen inline first). No wsXMR sourcing needed — the
/// new vault takes on the normalized debt and absorbs all remaining
/// collateral. Post-check: the absorbing vault must still cover
/// debt+pendingDebt at its OWN declared threshold. (EVM backstopVault parity.)

pub fn backstop_vault(ctx: Context<BackstopVault>) -> Result<()> {
    let old = &mut ctx.accounts.old_vault;
    let new = &mut ctx.accounts.new_vault;
    require!(old.active, WrapSynthError::VaultNotActive);
    require!(new.active, WrapSynthError::VaultNotActive);
    require!(old.key() != new.key(), WrapSynthError::InvalidValue);
    // The absorbing vault must itself be unencumbered.
    require!(!new.frozen, WrapSynthError::VaultFrozen);
    require!(!new.kick_active, WrapSynthError::KickActive);

    // An unresolved ENDED kick is resolved to frozen inline.
    if old.kick_active {
        require!(
            ctx.accounts.auction.is_some(),
            WrapSynthError::InvalidValue
        );
        let auction = ctx.accounts.auction.as_mut().unwrap();
        require!(auction.active, WrapSynthError::NoActiveKick);
        require!(
            auction.vault == vault_key_for(old),
            WrapSynthError::InvalidValue
        );
        require!(
            kick_phase(auction) == KickPhase::Ended,
            WrapSynthError::KickActive
        );
        resolve_kick_to_frozen_inline(
            old,
            auction,
            ctx.accounts.bond_escrow.as_ref(),
            ctx.accounts.kicker.as_ref(),
            &ctx.accounts.system_program,
        )?;
    }
    require!(old.frozen, WrapSynthError::InvalidStatus);

    // Belt & suspenders: settlement must have run before absorption.
    require!(old.active_burn_count == 0, WrapSynthError::UnresolvedBurns);
    require!(old.deployed_collateral == 0, WrapSynthError::UnresolvedBurns);

    let global_debt_index = ctx.accounts.global_state.load()?.global_debt_index;
    let old_debt = get_actual_debt(old.normalized_debt, global_debt_index);
    require!(old_debt > 0, WrapSynthError::InsufficientDebt);

    let absorbed = old.collateral_amount;

    // New vault assumes the debt and absorbs all remaining collateral.
    new.normalized_debt = new
        .normalized_debt
        .checked_add(old.normalized_debt)
        .ok_or(WrapSynthError::MathOverflow)?;
    new.collateral_amount = new
        .collateral_amount
        .checked_add(absorbed)
        .ok_or(WrapSynthError::MathOverflow)?;

    // Physically migrate the collateral lamports to the new vault's escrow so
    // the accounting matches custody.
    if absorbed > 0 {
        let (old_pda_key, _) = Pubkey::find_program_address(
            &[VAULT_SEED, old.lp_address.as_ref()],
            &crate::ID,
        );
        let escrow_bump = ctx.bumps.old_vault_collateral_escrow;
        let seeds: &[&[u8]] = &[
            VAULT_COLLATERAL_SEED,
            old_pda_key.as_ref(),
            &[escrow_bump],
        ];
        invoke_signed(
            &system_instruction::transfer(
                &ctx.accounts.old_vault_collateral_escrow.key(),
                &ctx.accounts.new_vault_collateral_escrow.key(),
                absorbed,
            ),
            &[
                ctx.accounts.old_vault_collateral_escrow.to_account_info(),
                ctx.accounts.new_vault_collateral_escrow.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
            &[seeds],
        )?;
    }

    // Zero out old vault — clear ALL state to prevent phantom locked collateral.
    old.normalized_debt = 0;
    old.collateral_amount = 0;
    old.locked_collateral = 0;
    old.deployed_collateral = 0;
    old.liquidation_nonce = old
        .liquidation_nonce
        .checked_add(1)
        .ok_or(WrapSynthError::MathOverflow)?;
    old.mint_nonce = old
        .mint_nonce
        .checked_add(1)
        .ok_or(WrapSynthError::MathOverflow)?;
    old.frozen = false;
    // pending_debt is intentionally NOT zeroed — invalidated mint requests
    // release their own reservations on cancel/finalize (EVM parity).

    // Post-check: absorbing vault must cover debt+pendingDebt at its own
    // declared threshold (EVM backstopVault parity).
    let new_debt = get_actual_debt(new.normalized_debt, global_debt_index);
    let free_new = new.collateral_amount.saturating_sub(new.locked_collateral);
    let required = par_lamports(
        new_debt.saturating_add(new.pending_debt),
        new.threshold_lamports_per_wsxmr,
    );
    require!(
        free_new >= required,
        WrapSynthError::InsufficientCollateral
    );

    msg!(
        "Vault backstopped: old {} → new {}, {} debt, {} collateral absorbed",
        old.lp_address,
        new.lp_address,
        old_debt,
        absorbed
    );
    Ok(())
}

/// Inline ENDED-kick → FROZEN resolution for backstop_vault. Mirrors
/// resolve_kick's body — the bond returns to the kicker recorded on the
/// auction.
fn resolve_kick_to_frozen_inline<'info>(
    old: &mut Vault,
    auction: &mut Box<Account<'info, Auction>>,
    bond_escrow: Option<&AccountInfo<'info>>,
    kicker: Option<&AccountInfo<'info>>,
    system_program: &Program<'info, System>,
) -> Result<()> {
    if !auction.auction_opened {
        require!(
            old.active_burn_count == 0 && old.deployed_collateral == 0,
            WrapSynthError::UnresolvedBurns
        );
        auction.auction_opened = true;
        old.liquidation_nonce = old
            .liquidation_nonce
            .checked_add(1)
            .ok_or(WrapSynthError::MathOverflow)?;
        old.mint_nonce = old
            .mint_nonce
            .checked_add(1)
            .ok_or(WrapSynthError::MathOverflow)?;
        auction.offered_collateral = old
            .collateral_amount
            .saturating_sub(old.locked_collateral);
    }

    old.frozen = true;
    old.last_kick_resolved = Clock::get()?.unix_timestamp;
    old.kick_active = false;

    let bond = auction.bond;
    if bond > 0 {
        require!(
            bond_escrow.is_some() && kicker.is_some(),
            WrapSynthError::InvalidValue
        );
        let kicker = kicker.unwrap();
        require!(kicker.key() == auction.kicker, WrapSynthError::InvalidValue);
        move_bond_lamports(
            &auction.vault,
            bond_escrow.unwrap(),
            kicker,
            system_program,
            bond,
        )?;
    }

    auction.active = false;
    auction.bond = 0;
    auction.offered_collateral = 0;
    Ok(())
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/// Dutch haircut X(t): linear decay from HAIRCUT_START_BPS to
/// HAIRCUT_FLOOR_BPS over AUCTION_DURATION_SECONDS, measured from the end of
/// the open delay. EVM _currentXBps parity.
fn current_x_bps(auction: &Auction) -> u64 {
    let now = Clock::get().map(|c| c.unix_timestamp).unwrap_or(0);
    let start = auction.kick_time + KICK_GRACE_SECONDS + AUCTION_OPEN_DELAY_SECONDS;
    if now <= start {
        return HAIRCUT_START_BPS;
    }
    let elapsed = now - start;
    if elapsed >= AUCTION_DURATION_SECONDS {
        return HAIRCUT_FLOOR_BPS;
    }
    let span = HAIRCUT_START_BPS - HAIRCUT_FLOOR_BPS;
    HAIRCUT_START_BPS - ((span as u128 * elapsed as u128) / AUCTION_DURATION_SECONDS as u128) as u64
}

/// Move lamports out of the per-vault bond-escrow PDA (program-signed system
/// transfer). `to` is any recipient — kicker wallet or vault escrow.
fn move_bond_lamports<'a>(
    vault_key: &Pubkey,
    bond_escrow: &AccountInfo<'a>,
    to: &AccountInfo<'a>,
    system_program: &Program<'a, System>,
    amount: u64,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    let (escrow_pda, bump) =
        Pubkey::find_program_address(&[AUCTION_BOND_SEED, vault_key.as_ref()], &crate::ID);
    require!(bond_escrow.key() == escrow_pda, WrapSynthError::InvalidValue);
    let seeds: &[&[u8]] = &[AUCTION_BOND_SEED, vault_key.as_ref(), &[bump]];
    invoke_signed(
        &system_instruction::transfer(&bond_escrow.key(), &to.key(), amount),
        &[
            bond_escrow.clone(),
            to.clone(),
            system_program.to_account_info(),
        ],
        &[seeds],
    )?;
    Ok(())
}

/// Move lamports out of a vault's collateral escrow (program-signed).
fn transfer_from_vault_escrow<'a>(
    vault: &Vault,
    vault_collateral_escrow: &AccountInfo<'a>,
    to: &AccountInfo<'a>,
    system_program: &Program<'a, System>,
    amount: u64,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    let vault_key = vault_key_for(vault);
    let (escrow_pda, bump) = Pubkey::find_program_address(
        &[VAULT_COLLATERAL_SEED, vault_key.as_ref()],
        &crate::ID,
    );
    require!(
        vault_collateral_escrow.key() == escrow_pda,
        WrapSynthError::InvalidValue
    );
    let seeds: &[&[u8]] = &[VAULT_COLLATERAL_SEED, vault_key.as_ref(), &[bump]];
    invoke_signed(
        &system_instruction::transfer(&vault_collateral_escrow.key(), &to.key(), amount),
        &[
            vault_collateral_escrow.clone(),
            to.clone(),
            system_program.to_account_info(),
        ],
        &[seeds],
    )?;
    Ok(())
}

// ─── Accounts ────────────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct Kick<'info> {
    #[account(mut)]
    pub kicker: Signer<'info>,

    #[account(
        mut,
        seeds = [VAULT_SEED, vault.lp_address.as_ref()],
        bump = vault.bump,
    )]
    pub vault: Box<Account<'info, Vault>>,

    #[account(
        init_if_needed,
        payer = kicker,
        space = Auction::LEN,
        seeds = [AUCTION_SEED, vault.key().as_ref()],
        bump,
    )]
    pub auction: Box<Account<'info, Auction>>,

    /// CHECK: per-vault lamport bond-escrow PDA — validated by seeds
    #[account(
        mut,
        seeds = [AUCTION_BOND_SEED, vault.key().as_ref()],
        bump,
    )]
    pub bond_escrow: AccountInfo<'info>,

    #[account(
        seeds = [GLOBAL_STATE_SEED],
        bump,
    )]
    pub global_state: AccountLoader<'info, GlobalState>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Reauction<'info> {
    #[account(mut)]
    pub kicker: Signer<'info>,

    #[account(
        mut,
        seeds = [VAULT_SEED, vault.lp_address.as_ref()],
        bump = vault.bump,
    )]
    pub vault: Box<Account<'info, Vault>>,

    #[account(
        init_if_needed,
        payer = kicker,
        space = Auction::LEN,
        seeds = [AUCTION_SEED, vault.key().as_ref()],
        bump,
    )]
    pub auction: Box<Account<'info, Auction>>,

    /// CHECK: per-vault lamport bond-escrow PDA — validated by seeds
    #[account(
        mut,
        seeds = [AUCTION_BOND_SEED, vault.key().as_ref()],
        bump,
    )]
    pub bond_escrow: AccountInfo<'info>,

    #[account(
        seeds = [GLOBAL_STATE_SEED],
        bump,
    )]
    pub global_state: AccountLoader<'info, GlobalState>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ResolveBurnForAuction<'info> {
    #[account(mut)]
    pub caller: Signer<'info>,

    #[account(
        mut,
        seeds = [VAULT_SEED, vault.lp_address.as_ref()],
        bump = vault.bump,
    )]
    pub vault: Box<Account<'info, Vault>>,

    #[account(
        seeds = [AUCTION_SEED, vault.key().as_ref()],
        bump = auction.bump,
    )]
    pub auction: Box<Account<'info, Auction>>,

    #[account(
        mut,
        seeds = [GLOBAL_STATE_SEED],
        bump,
    )]
    pub global_state: AccountLoader<'info, GlobalState>,

    #[account(
        mut,
        seeds = [BURN_REQUEST_SEED, burn_request.request_id.as_ref()],
        bump = burn_request.bump,
    )]
    pub burn_request: Box<Account<'info, BurnRequest>>,

    #[account(
        init_if_needed,
        payer = caller,
        space = PendingReturns::LEN,
        seeds = [PENDING_RETURNS_SEED, burn_request.user.as_ref()],
        bump,
    )]
    pub user_pending_returns: Box<Account<'info, PendingReturns>>,

    #[account(mut)]
    pub wsxmr_mint: Box<InterfaceAccount<'info, Mint>>,

    #[account(mut)]
    pub user_wsxmr_ata: Box<InterfaceAccount<'info, TokenAccount>>,

    /// CHECK: lamport-only vault collateral escrow PDA — validated by seeds
    #[account(
        mut,
        seeds = [VAULT_COLLATERAL_SEED, vault.key().as_ref()],
        bump,
    )]
    pub vault_collateral_escrow: AccountInfo<'info>,

    /// CHECK: lamport-only program collateral pool PDA — validated by seeds
    #[account(
        mut,
        seeds = [PROGRAM_COLLATERAL_SEED],
        bump,
    )]
    pub collateral_escrow: AccountInfo<'info>,

    pub token_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct OpenAuction<'info> {
    /// CHECK: permissionless — anyone can open the auction after grace
    #[account(mut)]
    pub caller: Signer<'info>,

    #[account(
        mut,
        seeds = [VAULT_SEED, vault.lp_address.as_ref()],
        bump = vault.bump,
    )]
    pub vault: Box<Account<'info, Vault>>,

    #[account(
        mut,
        seeds = [AUCTION_SEED, vault.key().as_ref()],
        bump = auction.bump,
    )]
    pub auction: Box<Account<'info, Auction>>,
}

#[derive(Accounts)]
pub struct Bid<'info> {
    #[account(mut)]
    pub bidder: Signer<'info>,

    #[account(
        mut,
        seeds = [VAULT_SEED, vault.lp_address.as_ref()],
        bump = vault.bump,
    )]
    pub vault: Box<Account<'info, Vault>>,

    #[account(
        mut,
        seeds = [AUCTION_SEED, vault.key().as_ref()],
        bump = auction.bump,
    )]
    pub auction: Box<Account<'info, Auction>>,

    /// CHECK: recorded kicker — receives bond/chip payouts
    #[account(
        mut,
        constraint = kicker.key() == auction.kicker @ WrapSynthError::InvalidValue,
    )]
    pub kicker: AccountInfo<'info>,

    /// CHECK: per-vault lamport bond-escrow PDA — validated by seeds
    #[account(
        mut,
        seeds = [AUCTION_BOND_SEED, vault.key().as_ref()],
        bump,
    )]
    pub bond_escrow: AccountInfo<'info>,

    #[account(
        mut,
        seeds = [GLOBAL_STATE_SEED],
        bump,
    )]
    pub global_state: AccountLoader<'info, GlobalState>,

    #[account(mut)]
    pub wsxmr_mint: InterfaceAccount<'info, Mint>,

    #[account(mut)]
    pub bidder_wsxmr_ata: InterfaceAccount<'info, TokenAccount>,

    /// CHECK: lamport-only vault collateral escrow PDA — validated by seeds
    #[account(
        mut,
        seeds = [VAULT_COLLATERAL_SEED, vault.key().as_ref()],
        bump,
    )]
    pub vault_collateral_escrow: AccountInfo<'info>,

    pub token_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ResolveKick<'info> {
    /// CHECK: permissionless — anyone can resolve after the auction ends
    #[account(mut)]
    pub caller: Signer<'info>,

    #[account(
        mut,
        seeds = [VAULT_SEED, vault.lp_address.as_ref()],
        bump = vault.bump,
    )]
    pub vault: Box<Account<'info, Vault>>,

    #[account(
        mut,
        seeds = [AUCTION_SEED, vault.key().as_ref()],
        bump = auction.bump,
    )]
    pub auction: Box<Account<'info, Auction>>,

    /// CHECK: recorded kicker — bond returns here on a no-bid resolution
    #[account(
        mut,
        constraint = kicker.key() == auction.kicker @ WrapSynthError::InvalidValue,
    )]
    pub kicker: AccountInfo<'info>,

    /// CHECK: per-vault lamport bond-escrow PDA — validated by seeds
    #[account(
        mut,
        seeds = [AUCTION_BOND_SEED, vault.key().as_ref()],
        bump,
    )]
    pub bond_escrow: AccountInfo<'info>,

    /// CHECK: lamport-only vault collateral escrow PDA — validated by seeds
    #[account(
        mut,
        seeds = [VAULT_COLLATERAL_SEED, vault.key().as_ref()],
        bump,
    )]
    pub vault_collateral_escrow: AccountInfo<'info>,

    #[account(
        seeds = [GLOBAL_STATE_SEED],
        bump,
    )]
    pub global_state: AccountLoader<'info, GlobalState>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct BackstopVault<'info> {
    #[account(mut)]
    pub new_lp: Signer<'info>,

    #[account(
        mut,
        seeds = [VAULT_SEED, old_vault.lp_address.as_ref()],
        bump = old_vault.bump,
    )]
    pub old_vault: Box<Account<'info, Vault>>,

    #[account(
        mut,
        seeds = [VAULT_SEED, new_lp.key().as_ref()],
        bump = new_vault.bump,
        constraint = new_vault.lp_address == new_lp.key() @ WrapSynthError::Unauthorized,
    )]
    pub new_vault: Box<Account<'info, Vault>>,

    /// Optional auction record — pass when the old vault's kick is still
    /// active-but-ended so it can be resolved to frozen inline.
    #[account(
        mut,
        seeds = [AUCTION_SEED, old_vault.key().as_ref()],
        bump = auction.bump,
    )]
    pub auction: Option<Box<Account<'info, Auction>>>,

    /// CHECK: recorded kicker — required when auction is passed (bond refund)
    #[account(mut)]
    pub kicker: Option<AccountInfo<'info>>,

    /// CHECK: per-vault lamport bond-escrow PDA — required when auction is passed
    #[account(
        mut,
        seeds = [AUCTION_BOND_SEED, old_vault.key().as_ref()],
        bump,
    )]
    pub bond_escrow: Option<AccountInfo<'info>>,

    #[account(
        mut,
        seeds = [GLOBAL_STATE_SEED],
        bump,
    )]
    pub global_state: AccountLoader<'info, GlobalState>,

    /// CHECK: old vault's lamport collateral escrow — source of the absorbed balance
    #[account(
        mut,
        seeds = [VAULT_COLLATERAL_SEED, old_vault.key().as_ref()],
        bump,
    )]
    pub old_vault_collateral_escrow: AccountInfo<'info>,

    /// CHECK: new vault's lamport collateral escrow — destination
    #[account(
        mut,
        seeds = [VAULT_COLLATERAL_SEED, new_vault.key().as_ref()],
        bump,
    )]
    pub new_vault_collateral_escrow: AccountInfo<'info>,

    pub token_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
}
