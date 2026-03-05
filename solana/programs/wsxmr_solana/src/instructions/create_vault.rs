use anchor_lang::prelude::*;
use crate::state::Vault;

#[derive(Accounts)]
#[instruction(collateral_mint: Pubkey)]
pub struct CreateVault<'info> {
    #[account(
        init,
        payer = lp,
        space = Vault::LEN,
        seeds = [Vault::SEED_PREFIX, lp.key().as_ref(), collateral_mint.as_ref()],
        bump
    )]
    pub vault: Account<'info, Vault>,
    
    #[account(mut)]
    pub lp: Signer<'info>,
    
    pub system_program: Program<'info, System>,
}

pub fn handler(ctx: Context<CreateVault>, collateral_mint: Pubkey) -> Result<()> {
    let vault = &mut ctx.accounts.vault;
    
    vault.lp_address = ctx.accounts.lp.key();
    vault.collateral_mint = collateral_mint;
    vault.collateral_amount = 0;
    vault.locked_collateral = 0;
    vault.normalized_debt = 0;
    vault.pending_debt = 0;
    vault.lp_principal = 0;
    vault.mint_fee_bps = 30; // 0.3% default
    vault.burn_reward_bps = 20; // 0.2% default
    vault.max_mint_bps = 5000; // 50% max per mint
    vault.mint_griefing_deposit = 10_000_000; // 0.01 SOL default
    vault.active = true;
    
    msg!("Vault created for LP: {}", ctx.accounts.lp.key());
    msg!("Collateral mint: {}", collateral_mint);
    
    Ok(())
}
