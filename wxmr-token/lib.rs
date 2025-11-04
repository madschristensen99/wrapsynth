use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Mint, MintTo, Burn};

declare_id!("WXMrTokenProgram11111111111111111111111111");

#[account]
pub struct Authority {
    pub admin: Pubkey,
    pub paused: bool,
}

#[program]
pub mod wxmr {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        let authority = &mut ctx.accounts.authority;
        authority.admin = *ctx.accounts.admin.key;
        authority.paused = false;
        
        msg!("wXMR initialized with {} decimals", ctx.accounts.wxmr_mint.decimals);
        Ok(())
    }

    pub fn mint(ctx: Context<MintWxmr>, amount: u64, xmr_tx_hash: [u8; 32]) -> Result<()> {
        require!(!ctx.accounts.authority.paused, ErrorCode::Paused);
        require!(*ctx.accounts.signer.key == ctx.accounts.authority.admin, ErrorCode::Unauthorized);
        
        let cpi_accounts = MintTo {
            mint: ctx.accounts.wxmr_mint.to_account_info(),
            to: ctx.accounts.recipient_account.to_account_info(),
            authority: ctx.accounts.signer.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        let cpi_ctx = CpiContext::new(cpi_program, cpi_accounts);
        token::mint_to(cpi_ctx, amount)?;
        
        msg!("Minted {} wXMR for XMR tx: {:x?}", amount, xmr_tx_hash);
        Ok(())
    }

    pub fn burn(ctx: Context<BurnWxmr>, amount: u64, xmr_destination: String) -> Result<()> {
        require!(!ctx.accounts.authority.paused, ErrorCode::Paused);
        
        let cpi_accounts = Burn {
            mint: ctx.accounts.wxmr_mint.to_account_info(),
            from: ctx.accounts.from_account.to_account_info(),
            authority: ctx.accounts.signer.to_account_info(),
        };
        let cpi_program = ctx.accounts.token_program.to_account_info();
        let cpi_ctx = CpiContext::new(cpi_program, cpi_accounts);
        token::burn(cpi_ctx, amount)?;
        
        msg!("Burned {} wXMR, sending XMR to {}", amount, xmr_destination);
        Ok(())
    }
}

#[derive(Accounts)]
#[instruction(decimals: u8)]
pub struct Initialize<'info> {
    #[account(
        init,
        payer = admin,
        space = 8 + 32 + 1,
        seeds = [b"authority"],
        bump
    )]
    pub authority: Account<'info, Authority>,
    
    #[account(
        init,
        payer = admin,
        mint::decimals = decimals, 
        mint::authority = admin,
    )]
    pub wxmr_mint: Account<'info, Mint>,
    
    #[account(mut)]
    pub admin: Signer<'info>,
    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
}

#[derive(Accounts)]
pub struct MintWxmr<'info> {
    #[account(
        seeds = [b"authority"],
        bump
    )]
    pub authority: Account<'info, Authority>,
    
    #[account(mut)]
    pub wxmr_mint: Account<'info, Mint>,
    
    #[account(
        mut,
        associated_token::mint = wxmr_mint,
        associated_token::authority = recipient
    )]
    pub recipient_account: Account<'info, TokenAccount>,
    
    pub recipient: AccountInfo<'info>,
    pub signer: Signer<'info>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct BurnWxmr<'info> {
    #[account(
        seeds = [b"authority"],
        bump
    )]
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

#[error_code]
pub enum ErrorCode {
    #[msg("Contract is paused")]
    Paused,
    #[msg("Unauthorized access")]
    Unauthorized,
}
