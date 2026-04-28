use anchor_lang::prelude::*;

use crate::constants::*;
use crate::errors::WrapSynthError;
use anchor_lang::AccountDeserialize;
use crate::state::{GlobalState, Vault};
use crate::utils::math::get_actual_debt;

/// Reconcile global_total_debt by summing actual debts from all provided vault PDAs.
///
/// This replaces the EVM reconcileGlobalDebt loop.
/// Vault PDAs are passed as remaining_accounts. Off-chain indexer (e.g. Helius)
/// must supply ALL active vaults for the result to be accurate.
///
/// This instruction is non-destructive: it only updates global_total_debt.
/// Anyone can call it.
pub fn reconcile_global_debt(ctx: Context<ReconcileGlobalDebt>) -> Result<()> {
    let global = &mut ctx.accounts.global_state;
    let old_debt = global.global_total_debt;

    let mut computed_debt: u64 = 0;
    for account_info in ctx.remaining_accounts.iter() {
        // Deserialize each remaining account as a Vault via raw borsh (avoids lifetime issues).
        let data = account_info.try_borrow_data()?;
        // Skip 8-byte anchor discriminator
        if data.len() < 8 {
            continue;
        }
        let vault = Vault::try_deserialize(&mut &data[..])
            .map_err(|_| WrapSynthError::VaultDoesNotExist)?;

        let actual = get_actual_debt(vault.normalized_debt, global.global_debt_index);
        computed_debt = computed_debt
            .checked_add(actual)
            .ok_or(WrapSynthError::MathOverflow)?;
    }

    global.global_total_debt = computed_debt;
    msg!("Global debt reconciled: {} → {}", old_debt, computed_debt);
    Ok(())
}

// ─── Accounts ────────────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct ReconcileGlobalDebt<'info> {
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [GLOBAL_STATE_SEED],
        bump = global_state.bump,
        constraint = global_state.authority == authority.key() @ WrapSynthError::Unauthorized,
    )]
    pub global_state: Account<'info, GlobalState>,
    // remaining_accounts: Vec<AccountInfo> of Vault PDAs
}
