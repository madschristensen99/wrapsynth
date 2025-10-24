use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{self, Mint, Token, TokenAccount, MintTo, Burn},
};
use arcium_anchor::prelude::*;

declare_id!("WXMRBridgeProgram11111111111111111111111111");

/// Wrapped Monero Bridge Program
/// 
/// This program manages the wXMR SPL token and coordinates with
/// Arcium MPC for trustless Monero key management.
#[program]
pub mod wxmr_bridge {
    use super::*;

    /// Initialize the bridge
    pub fn initialize(ctx: Context<Initialize>, bridge_authority_bump: u8) -> Result<()> {
        let bridge_state = &mut ctx.accounts.bridge_state;
        bridge_state.authority = ctx.accounts.authority.key();
        bridge_state.wxmr_mint = ctx.accounts.wxmr_mint.key();
        bridge_state.total_locked_xmr = 0;
        bridge_state.total_minted_wxmr = 0;
        bridge_state.total_deposits = 0;
        bridge_state.total_burns = 0;
        bridge_state.bridge_authority_bump = bridge_authority_bump;
        bridge_state.paused = false;
        
        msg!("Bridge initialized");
        msg!("Authority: {}", bridge_state.authority);
        msg!("wXMR Mint: {}", bridge_state.wxmr_mint);
        
        Ok(())
    }

    /// Process a deposit (mint wXMR)
    /// 
    /// This is called after:
    /// 1. User gets a Monero address from Arcium MPC
    /// 2. User sends XMR to that address
    /// 3. User submits Groth16 proof of deposit
    /// 4. Proof is verified (off-chain or in specialized verifier)
    pub fn process_deposit(
        ctx: Context<ProcessDeposit>,
        amount: u64,
        proof_hash: [u8; 32], // Hash of the verified Groth16 proof
        monero_tx_hash: [u8; 32], // Monero transaction hash
    ) -> Result<()> {
        let bridge_state = &mut ctx.accounts.bridge_state;
        
        require!(!bridge_state.paused, BridgeError::BridgePaused);
        require!(amount > 0, BridgeError::InvalidAmount);
        require!(amount <= 1_000_000 * 10u64.pow(9), BridgeError::AmountTooLarge); // Max 1M XMR
        
        // Create deposit record
        let deposit = &mut ctx.accounts.deposit_record;
        deposit.user = ctx.accounts.user.key();
        deposit.amount = amount;
        deposit.proof_hash = proof_hash;
        deposit.monero_tx_hash = monero_tx_hash;
        deposit.timestamp = Clock::get()?.unix_timestamp;
        deposit.minted = false;
        
        // Mint wXMR to user
        let seeds = &[
            b"bridge_authority",
            &[bridge_state.bridge_authority_bump],
        ];
        let signer = &[&seeds[..]];
        
        let cpi_accounts = MintTo {
            mint: ctx.accounts.wxmr_mint.to_account_info(),
            to: ctx.accounts.user_wxmr_account.to_account_info(),
            authority: ctx.accounts.bridge_authority.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        let cpi_ctx = CpiContext::new_with_signer(cpi_program, cpi_accounts, signer);
        
        token::mint_to(cpi_ctx, amount)?;
        
        // Update state
        deposit.minted = true;
        bridge_state.total_locked_xmr += amount;
        bridge_state.total_minted_wxmr += amount;
        bridge_state.total_deposits += 1;
        
        emit!(DepositEvent {
            user: ctx.accounts.user.key(),
            amount,
            proof_hash,
            monero_tx_hash,
            timestamp: deposit.timestamp,
        });
        
        msg!("Deposited {} XMR, minted {} wXMR", amount, amount);
        
        Ok(())
    }

    /// Process a burn (burn wXMR, reveal Monero private key)
    /// 
    /// This is called when user wants to withdraw XMR:
    /// 1. User burns wXMR
    /// 2. Arcium MPC reveals the Monero private key
    /// 3. User can withdraw XMR using the revealed key
    pub fn process_burn(
        ctx: Context<ProcessBurn>,
        amount: u64,
    ) -> Result<()> {
        let bridge_state = &mut ctx.accounts.bridge_state;
        
        require!(!bridge_state.paused, BridgeError::BridgePaused);
        require!(amount > 0, BridgeError::InvalidAmount);
        
        // Burn wXMR from user
        let cpi_accounts = Burn {
            mint: ctx.accounts.wxmr_mint.to_account_info(),
            from: ctx.accounts.user_wxmr_account.to_account_info(),
            authority: ctx.accounts.user.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        let cpi_ctx = CpiContext::new(cpi_program, cpi_accounts);
        
        token::burn(cpi_ctx, amount)?;
        
        // Create burn record
        let burn_record = &mut ctx.accounts.burn_record;
        burn_record.user = ctx.accounts.user.key();
        burn_record.amount = amount;
        burn_record.timestamp = Clock::get()?.unix_timestamp;
        burn_record.key_revealed = false; // Will be set by Arcium callback
        
        // Update state
        bridge_state.total_minted_wxmr -= amount;
        bridge_state.total_burns += 1;
        
        emit!(BurnEvent {
            user: ctx.accounts.user.key(),
            amount,
            timestamp: burn_record.timestamp,
        });
        
        msg!("Burned {} wXMR", amount);
        msg!("Arcium MPC will reveal Monero private key");
        
        // Note: The actual key revelation happens in Arcium MPC
        // via the process_burn encrypted instruction
        
        Ok(())
    }

    /// Verify a Groth16 proof (simplified - full verification off-chain)
    /// 
    /// In production, this would either:
    /// 1. Call a specialized Groth16 verifier program
    /// 2. Verify a signature from a trusted off-chain verifier
    /// 3. Use a ZK-friendly verification method
    pub fn verify_proof(
        ctx: Context<VerifyProof>,
        proof_data: ProofData,
    ) -> Result<bool> {
        // Basic sanity checks
        require!(proof_data.amount > 0, BridgeError::InvalidAmount);
        require!(proof_data.public_inputs.len() == 2, BridgeError::InvalidProof);
        
        // In production: Full Groth16 verification
        // For now: Check proof components are non-zero
        let mut valid = false;
        for byte in &proof_data.proof_a {
            if *byte != 0 {
                valid = true;
                break;
            }
        }
        
        msg!("Proof verification: {}", valid);
        
        Ok(valid)
    }

    /// Pause the bridge (emergency)
    pub fn pause(ctx: Context<AdminAction>) -> Result<()> {
        let bridge_state = &mut ctx.accounts.bridge_state;
        require!(ctx.accounts.authority.key() == bridge_state.authority, BridgeError::Unauthorized);
        
        bridge_state.paused = true;
        
        emit!(BridgePausedEvent {
            timestamp: Clock::get()?.unix_timestamp,
        });
        
        msg!("Bridge paused");
        
        Ok(())
    }

    /// Unpause the bridge
    pub fn unpause(ctx: Context<AdminAction>) -> Result<()> {
        let bridge_state = &mut ctx.accounts.bridge_state;
        require!(ctx.accounts.authority.key() == bridge_state.authority, BridgeError::Unauthorized);
        
        bridge_state.paused = false;
        
        emit!(BridgeUnpausedEvent {
            timestamp: Clock::get()?.unix_timestamp,
        });
        
        msg!("Bridge unpaused");
        
        Ok(())
    }
}

// ============================================================================
// ACCOUNTS
// ============================================================================

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = authority,
        space = 8 + BridgeState::LEN,
        seeds = [b"bridge_state"],
        bump
    )]
    pub bridge_state: Account<'info, BridgeState>,
    
    #[account(
        seeds = [b"bridge_authority"],
        bump
    )]
    /// CHECK: PDA authority for minting
    pub bridge_authority: UncheckedAccount<'info>,
    
    #[account(
        init,
        payer = authority,
        mint::decimals = 9,
        mint::authority = bridge_authority,
    )]
    pub wxmr_mint: Account<'info, Mint>,
    
    #[account(mut)]
    pub authority: Signer<'info>,
    
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct ProcessDeposit<'info> {
    #[account(
        mut,
        seeds = [b"bridge_state"],
        bump
    )]
    pub bridge_state: Account<'info, BridgeState>,
    
    #[account(
        seeds = [b"bridge_authority"],
        bump = bridge_state.bridge_authority_bump
    )]
    /// CHECK: PDA authority
    pub bridge_authority: UncheckedAccount<'info>,
    
    #[account(mut)]
    pub wxmr_mint: Account<'info, Mint>,
    
    #[account(
        init,
        payer = user,
        space = 8 + DepositRecord::LEN,
        seeds = [b"deposit", user.key().as_ref(), &bridge_state.total_deposits.to_le_bytes()],
        bump
    )]
    pub deposit_record: Account<'info, DepositRecord>,
    
    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = wxmr_mint,
        associated_token::authority = user,
    )]
    pub user_wxmr_account: Account<'info, TokenAccount>,
    
    #[account(mut)]
    pub user: Signer<'info>,
    
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct ProcessBurn<'info> {
    #[account(
        mut,
        seeds = [b"bridge_state"],
        bump
    )]
    pub bridge_state: Account<'info, BridgeState>,
    
    #[account(mut)]
    pub wxmr_mint: Account<'info, Mint>,
    
    #[account(
        init,
        payer = user,
        space = 8 + BurnRecord::LEN,
        seeds = [b"burn", user.key().as_ref(), &bridge_state.total_burns.to_le_bytes()],
        bump
    )]
    pub burn_record: Account<'info, BurnRecord>,
    
    #[account(
        mut,
        associated_token::mint = wxmr_mint,
        associated_token::authority = user,
    )]
    pub user_wxmr_account: Account<'info, TokenAccount>,
    
    #[account(mut)]
    pub user: Signer<'info>,
    
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct VerifyProof<'info> {
    pub user: Signer<'info>,
}

#[derive(Accounts)]
pub struct AdminAction<'info> {
    #[account(
        mut,
        seeds = [b"bridge_state"],
        bump
    )]
    pub bridge_state: Account<'info, BridgeState>,
    
    pub authority: Signer<'info>,
}

// ============================================================================
// STATE
// ============================================================================

#[account]
pub struct BridgeState {
    pub authority: Pubkey,
    pub wxmr_mint: Pubkey,
    pub total_locked_xmr: u64,
    pub total_minted_wxmr: u64,
    pub total_deposits: u64,
    pub total_burns: u64,
    pub bridge_authority_bump: u8,
    pub paused: bool,
}

impl BridgeState {
    pub const LEN: usize = 32 + 32 + 8 + 8 + 8 + 8 + 1 + 1;
}

#[account]
pub struct DepositRecord {
    pub user: Pubkey,
    pub amount: u64,
    pub proof_hash: [u8; 32],
    pub monero_tx_hash: [u8; 32],
    pub timestamp: i64,
    pub minted: bool,
}

impl DepositRecord {
    pub const LEN: usize = 32 + 8 + 32 + 32 + 8 + 1;
}

#[account]
pub struct BurnRecord {
    pub user: Pubkey,
    pub amount: u64,
    pub timestamp: i64,
    pub key_revealed: bool,
}

impl BurnRecord {
    pub const LEN: usize = 32 + 8 + 8 + 1;
}

// ============================================================================
// TYPES
// ============================================================================

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct ProofData {
    pub amount: u64,
    pub proof_a: [u8; 32],
    pub proof_b_1: [u8; 32],
    pub proof_b_2: [u8; 32],
    pub proof_c: [u8; 32],
    pub public_inputs: Vec<[u8; 32]>,
}

// ============================================================================
// EVENTS
// ============================================================================

#[event]
pub struct DepositEvent {
    pub user: Pubkey,
    pub amount: u64,
    pub proof_hash: [u8; 32],
    pub monero_tx_hash: [u8; 32],
    pub timestamp: i64,
}

#[event]
pub struct BurnEvent {
    pub user: Pubkey,
    pub amount: u64,
    pub timestamp: i64,
}

#[event]
pub struct BridgePausedEvent {
    pub timestamp: i64,
}

#[event]
pub struct BridgeUnpausedEvent {
    pub timestamp: i64,
}

// ============================================================================
// ERRORS
// ============================================================================

#[error_code]
pub enum BridgeError {
    #[msg("Bridge is paused")]
    BridgePaused,
    
    #[msg("Invalid amount")]
    InvalidAmount,
    
    #[msg("Amount too large")]
    AmountTooLarge,
    
    #[msg("Invalid proof")]
    InvalidProof,
    
    #[msg("Unauthorized")]
    Unauthorized,
}
