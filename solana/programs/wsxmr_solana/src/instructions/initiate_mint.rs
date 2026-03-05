use anchor_lang::prelude::*;
use anchor_lang::system_program;
use crate::state::{GlobalState, Vault, MintRequest, MintStatus};
use crate::error::ErrorCode;
use crate::constants::MAX_MINT_TIMEOUT;

#[derive(Accounts)]
#[instruction(wsxmr_amount: u64, claim_commitment: [u8; 32], timeout_duration: i64)]
pub struct InitiateMint<'info> {
    #[account(
        init,
        payer = initiator,
        space = MintRequest::LEN,
        seeds = [
            MintRequest::SEED_PREFIX,
            &claim_commitment
        ],
        bump
    )]
    pub mint_request: Account<'info, MintRequest>,
    
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
    
    #[account(mut)]
    pub initiator: Signer<'info>,
    
    /// CHECK: Recipient can be any account
    pub recipient: UncheckedAccount<'info>,
    
    pub system_program: Program<'info, System>,
    pub clock: Sysvar<'info, Clock>,
}

pub fn handler(
    ctx: Context<InitiateMint>,
    wsxmr_amount: u64,
    claim_commitment: [u8; 32],
    timeout_duration: i64,
) -> Result<()> {
    let vault = &mut ctx.accounts.vault;
    let mint_request = &mut ctx.accounts.mint_request;
    let clock = &ctx.accounts.clock;
    
    require!(
        timeout_duration > 0 && timeout_duration <= MAX_MINT_TIMEOUT,
        ErrorCode::InvalidRequestStatus
    );
    
    let fee_amount = crate::utils::apply_bps_fee(wsxmr_amount, vault.mint_fee_bps)?;
    let total_amount = wsxmr_amount.checked_add(fee_amount)
        .ok_or(error!(ErrorCode::MathOverflow))?;
    
    let actual_debt = vault.get_actual_debt(ctx.accounts.global_state.global_debt_index)?;
    let max_mint = if actual_debt == 0 {
        vault.collateral_amount
    } else {
        crate::utils::apply_bps_fee(actual_debt, vault.max_mint_bps)?
    };
    
    require!(
        total_amount <= max_mint,
        ErrorCode::ExceedsMaxMintBounds
    );
    
    let griefing_deposit = vault.mint_griefing_deposit;
    require!(
        ctx.accounts.initiator.lamports() >= griefing_deposit,
        ErrorCode::InsufficientGriefingDeposit
    );
    
    system_program::transfer(
        CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            system_program::Transfer {
                from: ctx.accounts.initiator.to_account_info(),
                to: mint_request.to_account_info(),
            },
        ),
        griefing_deposit,
    )?;
    
    vault.pending_debt = vault.pending_debt
        .checked_add(total_amount)
        .ok_or(error!(ErrorCode::MathOverflow))?;
    
    mint_request.request_id = claim_commitment;
    mint_request.lp_vault = vault.key();
    mint_request.initiator = ctx.accounts.initiator.key();
    mint_request.recipient = ctx.accounts.recipient.key();
    mint_request.wsxmr_amount = wsxmr_amount;
    mint_request.fee_amount = fee_amount;
    mint_request.claim_commitment = claim_commitment;
    mint_request.timeout = clock.unix_timestamp + timeout_duration;
    mint_request.griefing_deposit = griefing_deposit;
    mint_request.set_status(MintStatus::Pending);
    
    msg!("Mint request initiated");
    msg!("Amount: {}, Fee: {}", wsxmr_amount, fee_amount);
    msg!("Timeout: {}", mint_request.timeout);
    
    Ok(())
}
