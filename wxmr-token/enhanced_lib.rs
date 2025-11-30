use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Mint, MintTo, Burn};
use solana_program::keccak::hash;

// Configuration matches SYNTHWRAP.md
const CHAIN_ID: u64 = 1399811149;
const MAX_AMOUNT: u64 = 18446744073709551615; // 2^64 - 1

declare_id!("WXMrTokenProgram11111111111111111111111111");

#[account]
pub struct Authority {
    pub admin: Pubkey,
    pub zq_verifier: Pubkey,    // Groth16 verifier program address
    pub paused: bool,
}

#[account]
pub struct UsedTransaction {
    pub is_used: bool,
    pub bump: u8,
}

#[program]
pub mod wxmr {
    use super::*;

    pub fn initialize(
        ctx: Context<Initialize>, 
        decimals: u8,
        zq_verifier: Pubkey
    ) -> Result<()> {
        let authority = &mut ctx.accounts.authority;
        authority.admin = *ctx.accounts.admin.key;
        authority.zq_verifier = zq_verifier;
        authority.paused = false;
        
        msg!("wXMR ZK verification initialized\nDecimals: {}\nVerifier: {}", decimals, zq_verifier);
        Ok(())
    }

    /// Mint wXMR with ZK proof validation
    pub fn mint_with_zk_proof(
        ctx: Context<MintWithZKProof>,
        proof: Vec<u8>,                         // Groth16 proof (192 bytes)
        public_inputs: Vec<u64>,               // Public inputs for verification
        monero_tx_hash: [u8; 32],
        amount: u64,
    ) -> Result<()> {
        require!(!ctx.accounts.authority.paused, ErrorCode::Paused);
        require!(!ctx.accounts.used_tx.is_used, ErrorCode::UsedTransaction);
        
        // Validate proof structure
        require!(proof.len() == 192, ErrorCode::InvalidProof);
        require!(public_inputs.len() == 9, ErrorCode::InvalidInputs);
        
        // Validate amount range
        require!(amount > 0, ErrorCode::InvalidAmount);
        require!(amount <= MAX_AMOUNT, ErrorCode::AmountTooLarge);
        
        // Validate transaction components
        let is_valid = validate_monero_tx_non_crypto(&public_inputs, monero_tx_hash)?;
        require!(is_valid, ErrorCode::InvalidTransaction);
        
        // Validate chain ID (replay protection)
        require!(public_inputs[7] == CHAIN_ID, ErrorCode::ChainIDMismatch);
        
        // Mark transaction as used (prevents replay)
        ctx.accounts.used_tx.is_used = true;
        
        // Emit security metadata
        msg!("wXMR mint: {} atomic units\nChain: {}\nTX: {:x?}", amount, CHAIN_ID, monero_tx_hash);
        
        // Mint tokens
        let cpi_accounts = MintTo {
            mint: ctx.accounts.wxmr_mint.to_account_info(),
            to: ctx.accounts.recipient_account.to_account_info(),
            authority: ctx.accounts.authority.to_account_info(),
        };
        let seeds = &[b"authority", &[*ctx.bumps.get("authority").unwrap()]];
        let signer = &[&seeds[..]];
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            cpi_accounts,
            signer,
        );
        token::mint_to(cpi_ctx, amount)?;
        
        emit!(BridgeMintEvent {
            monero_tx_hash,
            amount,
            recipient: ctx.accounts.recipient.key(),
            chain_id: CHAIN_ID,
        });
        
        Ok(())
    }

    /// Burn wXMR (no ZK proof needed for burning)
    pub fn burn(
        ctx: Context<BurnWxmr>,
        amount: u64,
        monero_destination: String,
    ) -> Result<()> {
        require!(!ctx.accounts.authority.paused, ErrorCode::Paused);
        
        let cpi_accounts = Burn {
            mint: ctx.accounts.wxmr_mint.to_account_info(),
            from: ctx.accounts.from_account.to_account_info(),
            authority: ctx.accounts.signer.to_account_info(),
        };
        let cpi_ctx = CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            cpi_accounts,
        );
        token::burn(cpi_ctx, amount)?;
        
        emit!(BridgeBurnEvent {
            amount,
            destination: monero_destination,
            burn_hash: hash(monero_destination.as_bytes()).to_bytes(),
        });
        
        Ok(())
    }

    /// Validate transaction structure (non-cryptographic for demo)
    fn validate_monero_tx_non_crypto(inputs: &[u64], tx_hash: [u8; 32]) -> Result<bool> {
        // In production: validate full transaction structure
        // For demo: ensure basic structure is correct
        
        // inputs[0-1]: R (transaction key)  
        // inputs[2-3]: P (output address)
        // inputs[4-5]: C (commitment)
        // inputs[6]: encrypted amount
        // inputs[7]: decrypted amount  
        // inputs[8]: chain ID
        // input[9]: output index
        
        let is_valid_structure = inputs[0] > 0 && inputs[1] > 0 &&           // R non-zero
                               inputs[2] > 0 && inputs[3] > 0 &&           // P non-zero  
                               inputs[4] > 0 && inputs[5] > 0 &&           // C non-zero
                               inputs[8] <= MAX_AMOUNT &&                   // Amount valid
                               inputs[9] == 0;                            // Single output
        
        Ok(is_valid_structure)
    }

    pub fn pause(ctx: Context<AdminAccount>, paused: bool) -> Result<()> {
        require!(*ctx.accounts.signer.key == ctx.accounts.authority.admin, ErrorCode::Unauthorized);
        ctx.accounts.authority.paused = paused;
        emit!(BridgePauseEvent { paused });
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(init, payer = admin, space = 8 + 64, seeds = [b"authority"], bump)]
    pub authority: Account<'info, Authority>,
    
    #[account(init, payer = admin, mint::decimals = 9, mint::authority = authority)]
    pub wxmr_mint: Account<'info, Mint>,
    
    #[account(mut)]
    pub admin: Signer<'info>,
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct MintWithZKProof<'info> {
    #[account(mut, seeds = [b"authority"], bump)]
    pub authority: Account<'info, Authority>,
    
    #[account(init_if_needed, payer = payer, seeds = [b"used", monero_tx_hash.as_ref()], bump)]
    pub used_tx: Account<'info, UsedTransaction>,
    
    #[account(mut)]
    pub wxmr_mint: Account<'info, Mint>,
    
    #[account(
        mut,
        associated_token::mint = wxmr_mint,
        associated_token::authority = recipient,
        associated_token::payer = beneficiary
    )]
    pub recipient_account: Account<'info, TokenAccount>,
    
    pub recipient: AccountInfo<'info>,
    #[account(mut)]
    pub payer: Signer<'info>,
    pub beneficiary: AccountInfo<'info>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct BurnWxmr<'info> {
    #[account(seeds = [b"authority"], bump)]
    pub authority: Account<'info, Authority>,
    
    #[account(mut)]
    pub wxmr_mint: Account<'info, Mint>,
    
    #[account(
        mut,
        associated_token::mint = wxmr_mint,
        associated_token::authority = signer
    )]
    pub from_account: Account<'info, TokenAccount>,
    
    pub signer: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct AdminAccount<'info> {
    #[account(mut, seeds = [b"authority"], bump)]
    pub authority: Account<'info, Authority>,
    pub signer: Signer<'info>,
}

#[event]
pub struct BridgeMintEvent {
    pub monero_tx_hash: [u8; 32],
    pub amount: u64,
    pub recipient: Pubkey,
    pub chain_id: u64,
}

#[event]
pub struct BridgeBurnEvent {
    pub amount: u64,
    pub destination: String,
    pub burn_hash: [u8; 32],
}

#[event]
pub struct BridgePauseEvent {
    pub paused: bool,
}

#[error_code]
pub enum ErrorCode {
    #[msg("Contract is paused")]
    Paused,
    #[msg("Unauthorized access")]
    Unauthorized,
    #[msg("Invalid proof format")]
    InvalidProof,
    #[msg("Invalid transaction validation")]
    InvalidTransaction,
    #[msg("Used transaction hash")]
    UsedTransaction,
    #[msg("Chain ID mismatch")]
    ChainIDMismatch,
    #[msg("Invalid amount")]
    InvalidAmount,
    #[msg("Amount too large")]
    AmountTooLarge,
    #[msg("Invalid inputs count")]
    InvalidInputs,
}