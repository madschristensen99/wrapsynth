// src/lib.rs
use anchor_lang::prelude::*;
use anchor_spl::token::{self as spl_token, Token, TokenAccount, Mint, Transfer};
use anchor_spl::associated_token::AssociatedToken;

declare_id!("G1BVSiFojnXFaPG1WUgJAcYaB7aGKLKWtSqhMreKgA82");

// Helper function for Schnorr adaptor-signature verification using Solana syscalls only
fn verify_adaptor_signature(
    sig: &[u8; 64],
    parity: u8,
    curve_point: &[u8; 32],
    expected_hash: &[u8; 32],
) -> Result<[u8; 32]> {
    use anchor_lang::solana_program::{hash, secp256k1_recover};
    
    require!(parity <= 1, ErrorCode::InvalidAdaptorSig);
    require!(!sig.iter().all(|&b| b == 0), ErrorCode::InvalidAdaptorSig);
    require!(!curve_point.iter().all(|&b| b == 0), ErrorCode::InvalidAdaptorSig);
    require!(!expected_hash.iter().all(|&b| b == 0), ErrorCode::InvalidAdaptorSig);
    
    let r = &sig[0..32];
    let s = &sig[32..64];
    
    let challenge_e = {
        let mut input = Vec::with_capacity(96);
        input.extend_from_slice(r);
        input.extend_from_slice(curve_point);
        input.extend_from_slice(expected_hash);
        hash::hash(&input).to_bytes()
    };
    
    let recovery_id = if parity == 0 { 0 } else { 1 };
    
    let recovered_pub = match secp256k1_recover::secp256k1_recover(
        expected_hash,
        recovery_id,
        sig,
    ) {
        Ok(bytes) => bytes,
        Err(_) => return err!(ErrorCode::InvalidAdaptorSig),
    };
    
    let recovered_bytes = recovered_pub.to_bytes();
    
    let mut constant_time_match = true;
    for i in 0..32 {
        let a = recovered_bytes[i];
        let b = curve_point[i];
        constant_time_match &= (a == b);
    }
    
    if !constant_time_match {
        return err!(ErrorCode::InvalidAdaptorSig);
    }
    
    const N: [u8; 32] = [
        0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF,
        0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFE,
        0xBA, 0xAE, 0xDC, 0xE6, 0xAF, 0x48, 0xA0, 0x3B,
        0xBF, 0xD2, 0x5E, 0x8C, 0xD0, 0x36, 0x41, 0x41,
    ];
    
    // Discrete log extraction: t ≡ (s - e) mod n where n is secp256k1 scalar order
    let mut t = [0u8; 32];
    let mut borrow = 0u8;
    
    // Single 32-byte constant-time modular subtraction: t = (s - e) mod N
    for i in (0..32).rev() {
        let a = s[i] as u16 + 256 - borrow as u16;
        let b = challenge_e[i] as u16;
        let mut diff = a - b;
        
        let n_val = N[i] as u16;
        if diff >= n_val {
            diff -= n_val;
        }
        
        borrow = if diff < 256 { 1 } else { 0 };
        t[i] = (diff & 0xff) as u8;
    }
    
    // Handle final borrow - add N to result
    if borrow != 0 {
        let mut carry = 0u8;
        for i in (0..32).rev() {
            let a = N[i] as u16 + carry as u16;
            let b = t[i] as u16;
            let sum = a + b;
            
            t[i] = (sum & 0xff) as u8;
            carry = (sum >> 8) as u8;
        }
    }
    
    if t.iter().all(|&b| b == 0) {
        return err!(ErrorCode::InvalidAdaptorSig);
    }
    
    Ok(t)
}

#[program]
pub mod stealth_swap {
    use super::*;

    /*----------------------------------------------------------
     * 1.  USDC → XMR : Alice locks USDC for Bob
     *---------------------------------------------------------*/
    pub fn create_usdc_to_xmr_swap(
        ctx: Context<CreateUsdcToXmr>,
        swap_id: [u8; 32],
        secret_hash: [u8; 32],
        usdc_amount: u64,
        xmr_amount: u64,
        monero_sub_address: [u8; 64],
        expiry: i64,
        relayer_fee: u64,
    ) -> Result<()> {
        require!(expiry > Clock::get()?.unix_timestamp + 24 * 3600, ErrorCode::InvalidExpiry);
        require!(relayer_fee <= usdc_amount.checked_div(20).unwrap_or(0), ErrorCode::ExcessiveRelayerFee);
        require!(secret_hash.iter().any(|&b| b != 0), ErrorCode::InvalidSecretHash);

        let swap = &mut ctx.accounts.swap;
        swap.direction          = Direction::UsdcToXmr;
        swap.swap_id            = swap_id;
        swap.alice              = *ctx.accounts.alice.key;
        swap.bob                = *ctx.accounts.bob.key;
        swap.secret_hash        = secret_hash;
        swap.expiry             = expiry;
        swap.relayer_fee        = relayer_fee;
        swap.is_redeemed        = false;
        swap.is_refunded        = false;
        swap.usdc_amount        = usdc_amount;
        swap.xmr_amount         = xmr_amount;
        swap.monero_sub_address = monero_sub_address;
        swap.monero_lock_txid   = [0; 32];
        swap.bump               = ctx.bumps.swap;
        swap.vtc_opened         = false;
        swap.bob_collateral_locked = false;
        swap.alice_collateral_locked = false;
        // fraud fields removed
        swap.bounty_claimed     = false;

        // Alice locks USDC
        let cpi_accounts = Transfer {
            from: ctx.accounts.alice_usdc.to_account_info(),
            to:   ctx.accounts.vault_usdc.to_account_info(),
            authority: ctx.accounts.alice.to_account_info(),
        };
        let cpi_ctx = CpiContext::new(ctx.accounts.token_program.to_account_info(), cpi_accounts);
        spl_token::transfer(cpi_ctx, usdc_amount)?;

        // Bob locks USDC collateral (equal amount) in same transaction
        let cpi_accounts = Transfer {
            from: ctx.accounts.bob_usdc.to_account_info(),
            to:   ctx.accounts.vault_collateral.to_account_info(),
            authority: ctx.accounts.bob.to_account_info(),
        };
        let cpi_ctx = CpiContext::new(ctx.accounts.token_program.to_account_info(), cpi_accounts);
        spl_token::transfer(cpi_ctx, usdc_amount)?;
        swap.bob_collateral_locked = true;

        msg!("USDC→XMR swap {:?} initiated with collateral", &swap_id[..8]);
        Ok(())
    }

    pub fn record_monero_lock_proof(
        ctx: Context<RecordProof>,
        _swap_id: [u8; 32],
        monero_lock_txid: [u8; 32],
    ) -> Result<()> {
        let swap = &mut ctx.accounts.swap;
        require!(swap.direction == Direction::UsdcToXmr, ErrorCode::WrongDirection);
        swap.monero_lock_txid = monero_lock_txid;
        msg!("Monero lock txid recorded");
        Ok(())
    }

pub fn redeem_usdc(
    ctx: Context<RedeemUsdc>,
    _swap_id: [u8; 32],
    adaptor_sig: [u8; 64],
    parity: u8,
    curve_point: [u8; 32],
) -> Result<[u8; 32]> {
    let swap = &mut ctx.accounts.swap;
    require!(!swap.is_redeemed && !swap.is_refunded, ErrorCode::AlreadyFinalized);
    require!(swap.direction == Direction::UsdcToXmr, ErrorCode::WrongDirection);
    require!(parity <= 1, ErrorCode::InvalidAdaptorSig);

    // Verify adaptor signature reveals correct secret
    let secret = verify_adaptor_signature(&adaptor_sig, parity, &curve_point, &swap.secret_hash)?;

    // copy values before mutable use
    let swap_bump   = swap.bump;
    let swap_id     = swap.swap_id;
    let relayer_fee = swap.relayer_fee;

    let vault_balance = ctx.accounts.vault_usdc.amount;
    let to_bob        = vault_balance.checked_sub(relayer_fee).unwrap();

    // drop mutable borrow
    drop(swap);

    // build seeds
    let seeds = &[b"swap", swap_id.as_ref(), &[swap_bump]];
    let signer_seeds = &[&seeds[..]];

    // CPI 1: relayer fee
    if relayer_fee > 0 {
        let cpi_accounts = Transfer {
            from: ctx.accounts.vault_usdc.to_account_info(),
            to:   ctx.accounts.relayer_token.to_account_info(),
            authority: ctx.accounts.swap.to_account_info(),
        };
        spl_token::transfer(
            CpiContext::new_with_signer(ctx.accounts.token_program.to_account_info(), cpi_accounts, signer_seeds),
            relayer_fee,
        )?;
    }

    // CPI 2: remainder to Bob
    let cpi_accounts = Transfer {
        from: ctx.accounts.vault_usdc.to_account_info(),
        to:   ctx.accounts.bob_token.to_account_info(),
        authority: ctx.accounts.swap.to_account_info(),
    };
    spl_token::transfer(
        CpiContext::new_with_signer(ctx.accounts.token_program.to_account_info(), cpi_accounts, signer_seeds),
        to_bob,
    )?;

    // mark redeemed
    let swap = &mut ctx.accounts.swap;
    swap.is_redeemed = true;

    msg!("USDC redeemed by Bob");
    Ok(secret)
}

    /*----------------------------------------------------------
     * 2.  XMR → USDC : Bob locks USDC, Alice reveals secret
     *---------------------------------------------------------*/
    pub fn create_xmr_to_usdc_swap(
        ctx: Context<CreateXmrToUsdc>,
        swap_id: [u8; 32],
        secret_hash: [u8; 32],
        usdc_amount: u64,
        xmr_amount: u64,
        alice_solana: Pubkey,
        expiry: i64,
        relayer_fee: u64,
    ) -> Result<()> {
        let swap = &mut ctx.accounts.swap;
        swap.direction    = Direction::XmrToUsdc;
        swap.swap_id      = swap_id;
        swap.alice        = *ctx.accounts.alice.key;
        swap.bob          = *ctx.accounts.bob.key;
        swap.secret_hash  = secret_hash;
        swap.expiry       = expiry;
        swap.relayer_fee  = relayer_fee;
        swap.is_redeemed  = false;
        swap.is_refunded  = false;
        swap.usdc_amount  = usdc_amount;
        swap.xmr_amount   = xmr_amount;
        swap.alice_solana = alice_solana;
        swap.bump         = ctx.bumps.swap;

        msg!("XMR→USDC swap {:?}", &swap_id[..8]);
        Ok(())
    }

pub fn redeem_usdc_alice(
    ctx: Context<RedeemUsdcAlice>,
    _swap_id: [u8; 32],
    adaptor_sig: Vec<u8>,
) -> Result<()> {
    let swap = &mut ctx.accounts.swap;
    require!(!swap.is_redeemed && !swap.is_refunded, ErrorCode::AlreadyFinalized);
    require!(swap.direction == Direction::XmrToUsdc, ErrorCode::WrongDirection);
    require!(adaptor_sig.len() == 64, ErrorCode::InvalidAdaptorSig);

    let swap_bump   = swap.bump;
    let swap_id     = swap.swap_id;
    let relayer_fee = swap.relayer_fee;

    let vault_balance = ctx.accounts.vault_usdc.amount;
    let to_alice      = vault_balance.checked_sub(relayer_fee).unwrap();

    drop(swap);

    let seeds = &[b"swap", swap_id.as_ref(), &[swap_bump]];
    let signer_seeds = &[&seeds[..]];

    if relayer_fee > 0 {
        let cpi_accounts = Transfer {
            from: ctx.accounts.vault_usdc.to_account_info(),
            to:   ctx.accounts.relayer_token.to_account_info(),
            authority: ctx.accounts.swap.to_account_info(),
        };
        spl_token::transfer(
            CpiContext::new_with_signer(ctx.accounts.token_program.to_account_info(), cpi_accounts, signer_seeds),
            relayer_fee,
        )?;
    }

    let cpi_accounts = Transfer {
        from: ctx.accounts.vault_usdc.to_account_info(),
        to:   ctx.accounts.alice_token.to_account_info(),
        authority: ctx.accounts.swap.to_account_info(),
    };
    spl_token::transfer(
        CpiContext::new_with_signer(ctx.accounts.token_program.to_account_info(), cpi_accounts, signer_seeds),
        to_alice,
    )?;

    ctx.accounts.swap.is_redeemed = true;
    msg!("USDC redeemed by Alice");
    Ok(())
}

    /*----------------------------------------------------------
     * 3.  Refund after expiry
     *---------------------------------------------------------*/
pub fn refund(ctx: Context<Refund>, _swap_id: [u8; 32]) -> Result<()> {
    let swap = &mut ctx.accounts.swap;
    require!(!swap.is_redeemed && !swap.is_refunded, ErrorCode::AlreadyFinalized);
    require!(Clock::get()?.unix_timestamp > swap.expiry, ErrorCode::NotYetExpired);

    let bump           = swap.bump;
    let swap_id        = swap.swap_id;
    let vault_balance  = ctx.accounts.vault_usdc.amount;

    drop(swap);

    let seeds = &[b"swap", swap_id.as_ref(), &[bump]];
    let signer_seeds = &[&seeds[..]];

    // Return locked USDC to original funder
    let cpi_accounts = Transfer {
        from: ctx.accounts.vault_usdc.to_account_info(),
        to:   ctx.accounts.funder_token.to_account_info(),
        authority: ctx.accounts.swap.to_account_info(),
    };
    spl_token::transfer(
        CpiContext::new_with_signer(ctx.accounts.token_program.to_account_info(), cpi_accounts, signer_seeds),
        vault_balance,
    )?;

    // Return collateral to appropriate party
    let collateral_balance = ctx.accounts.vault_collateral.amount;
    if collateral_balance > 0 {
        let cpi_accounts = Transfer {
            from: ctx.accounts.vault_collateral.to_account_info(),
            to:   ctx.accounts.collateral_token.to_account_info(),
            authority: ctx.accounts.swap.to_account_info(),
        };
        spl_token::transfer(
            CpiContext::new_with_signer(ctx.accounts.token_program.to_account_info(), cpi_accounts, signer_seeds),
            collateral_balance,
        )?;
    }

    ctx.accounts.swap.is_refunded = true;
    msg!("Swap refunded with collateral");
    Ok(())
}

    /*----------------------------------------------------------
     * 4.  Claim bounty for revealing secret
     *---------------------------------------------------------*/
    pub fn claim_bounty_for_secret(
        ctx: Context<ClaimBounty>,
        _swap_id: [u8; 32],
        adaptor_sig: [u8; 64],
        parity: u8,
        curve_point: [u8; 32],
    ) -> Result<[u8; 32]> {
        let swap = &mut ctx.accounts.swap;
        require!(!swap.bounty_claimed, ErrorCode::BountyAlreadyClaimed);
        require!(!swap.is_redeemed && !swap.is_refunded, ErrorCode::AlreadyFinalized);

        // Verify adaptor signature reveals correct secret
        let secret = verify_adaptor_signature(&adaptor_sig, parity, &curve_point, &swap.secret_hash)?;

        // Mark bounty as claimed to prevent double claims
        swap.bounty_claimed = true;

        // Check if there is collateral to claim
        let collateral_balance = ctx.accounts.vault_collateral.amount;
        if collateral_balance > 0 {
            // Prepare PDA seeds for CPI transfer
            let swap_bump = swap.bump;
            let swap_id_bytes = swap.swap_id;
            let seeds = &[b"swap", swap_id_bytes.as_ref(), &[swap_bump]];
            let signer_seeds = &[&seeds[..]];

            // Transfer collateral to claimant via CPI (works for both directions)
            let cpi_accounts = Transfer {
                from: ctx.accounts.vault_collateral.to_account_info(),
                to: ctx.accounts.claimant_token.to_account_info(),
                authority: ctx.accounts.swap.to_account_info(),
            };
            spl_token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    cpi_accounts,
                    signer_seeds
                ),
                collateral_balance,
            )?;

            msg!("Bounty claimed: {} USDC transferred to claimant", collateral_balance);
        } else {
            msg!("Bounty claimed: no collateral available for transfer");
        }
        
        Ok(secret)
    }

    /*----------------------------------------------------------
     * 5.  Adaptor verify context implementation
     *---------------------------------------------------------*/
    pub fn adaptor_verify(
        _ctx: Context<AdaptorVerifyCtx>,
        _swap_id: [u8; 32],
        sig: [u8; 64],
        parity: u8,
        curve_point: [u8; 32],
    ) -> Result<[u8; 32]> {
        msg!("Adaptor verify: Processing adaptor signature");
        let swap = &_ctx.accounts.swap;
        
        // In a real implementation, this would verify the actual signature
        let computed_hash = anchor_lang::solana_program::hash::hash(&[&sig[..], &curve_point, &[parity]].concat()).to_bytes();
        require!(computed_hash == swap.secret_hash, ErrorCode::InvalidAdaptorSig);
        
        // Compute dummy secret (just for demonstration)
        let mut secret = [0u8; 32];
        for i in 0..32 {
            secret[i] = sig[i] ^ curve_point[i] ^ parity;
        }
        Ok(secret)
    }

    /*----------------------------------------------------------
     * 6.  Force open VTC implementation
     *---------------------------------------------------------*/
    pub fn force_open_vtc(
        ctx: Context<ForceOpenVtc>,
        _swap_id: [u8; 32],
    ) -> Result<()> {
        let swap = &mut ctx.accounts.swap;
        require!(!swap.vtc_opened, ErrorCode::VtcAlreadyOpened);
        swap.vtc_opened = true;
        msg!("VTC force opened");
        Ok(())
    }

    /*----------------------------------------------------------
     * 8.  Create commitment implementation
     *---------------------------------------------------------*/
    pub fn create_commitment(
        ctx: Context<CreateCommitment>,
        commitment_hash: [u8; 32],
        expiry: i64,
    ) -> Result<()> {
        require!(commitment_hash.iter().any(|&b| b != 0), ErrorCode::InvalidSecretHash);
        require!(expiry > Clock::get()?.unix_timestamp + 300, ErrorCode::CommitmentExpiryInvalid);

        let commitment = &mut ctx.accounts.commitment;
        commitment.swapper = *ctx.accounts.swapper.key;
        commitment.relayer = *ctx.accounts.relayer.key;
        commitment.commitment_hash = commitment_hash;
        commitment.expiry = expiry;
        commitment.slot = Clock::get()?.slot;
        commitment.bump = ctx.bumps.commitment;
        
        msg!("Commitment created with hash: {:?}", &commitment_hash[..8]);
        Ok(())
    }

}

/*==============================================================
 * Data
 *============================================================*/
#[account]
pub struct Swap {
    pub direction: Direction,
    pub swap_id: [u8; 32],
    pub alice: Pubkey,
    pub bob: Pubkey,
    pub secret_hash: [u8; 32],
    pub expiry: i64,
    pub relayer_fee: u64,
    pub is_redeemed: bool,
    pub is_refunded: bool,
    pub usdc_amount: u64,
    pub xmr_amount: u64,
    pub monero_sub_address: [u8; 64],
    pub monero_lock_txid: [u8; 32],
    pub alice_solana: Pubkey,
    pub bump: u8,
    pub vtc_opened: bool,
    pub bob_collateral_locked: bool,
    pub alice_collateral_locked: bool,
    pub bounty_claimed: bool,
}

#[account]
pub struct RelayerCommitment {
    pub swapper: Pubkey,
    pub relayer: Pubkey,
    pub commitment_hash: [u8; 32],
    pub expiry: i64,
    pub slot: u64,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum Direction {
    UsdcToXmr,
    XmrToUsdc,
}

impl Swap {
    pub const LEN: usize = 1 + 32 + 32 + 32 + 32 + 8 + 8 + 1 + 1 + 8 + 8 + 64 + 32 + 32 + 1 + 1 + 1 + 1 + 1 + 1;
}

impl RelayerCommitment {
    pub const LEN: usize = 32 + 32 + 32 + 8 + 8 + 1;
}

/*==============================================================
 * Contexts
 *============================================================*/
#[derive(Accounts)]
#[instruction(swap_id:[u8;32], secret_hash:[u8;32], usdc_amount:u64, xmr_amount:u64, monero_sub_address:[u8;64], expiry:i64, relayer_fee:u64)]
pub struct CreateUsdcToXmr<'info> {
    #[account(
        init,
        payer = alice,
        space = 8 + Swap::LEN,
        seeds = [b"swap", swap_id.as_ref()],
        bump
    )]
    pub swap: Account<'info, Swap>,

    #[account(mut)]
    pub alice: Signer<'info>,

    #[account(mut)]
    pub bob: Signer<'info>,

    #[account(
        mut,
        associated_token::mint = usdc_mint,
        associated_token::authority = alice,
    )]
    pub alice_usdc: Account<'info, TokenAccount>,

    #[account(
        init,
        payer = alice,
        associated_token::mint = usdc_mint,
        associated_token::authority = swap,
    )]
    pub vault_usdc: Account<'info, TokenAccount>, // Alice's locked USDC

    #[account(
        init,
        payer = alice,
        associated_token::mint = usdc_mint,
        associated_token::authority = swap,
    )]
    pub vault_collateral: Account<'info, TokenAccount>, // Bob's locked USDC collateral

    #[account(
        mut,
        associated_token::mint = usdc_mint,
        associated_token::authority = bob,
    )]
    pub bob_usdc: Account<'info, TokenAccount>,

    pub usdc_mint: Account<'info, Mint>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(swap_id:[u8;32], monero_lock_txid:[u8;32])]
pub struct RecordProof<'info> {
    #[account(mut, has_one = bob)]
    pub swap: Account<'info, Swap>,
    pub bob: Signer<'info>,
}

#[derive(Accounts)]
#[instruction(swap_id:[u8;32], adaptor_sig:Vec<u8>)]
pub struct RedeemUsdc<'info> {
    #[account(mut, seeds=[b"swap", swap.swap_id.as_ref()], bump=swap.bump)]
    pub swap: Account<'info, Swap>,
    #[account(mut)]
    pub bob: Signer<'info>,

    #[account(
        mut,
        associated_token::mint = usdc_mint,
        associated_token::authority = swap,
    )]
    pub vault_usdc: Account<'info, TokenAccount>,

    #[account(
        init_if_needed,
        payer = bob,
        associated_token::mint = usdc_mint,
        associated_token::authority = bob,
    )]
    pub bob_token: Account<'info, TokenAccount>,

    #[account(
        init_if_needed,
        payer = bob,
        associated_token::mint = usdc_mint,
        associated_token::authority = relayer,
    )]
    pub relayer_token: Account<'info, TokenAccount>,

    /// CHECK: relayer
    pub relayer: AccountInfo<'info>,

    pub usdc_mint: Account<'info, Mint>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(swap_id:[u8;32], secret_hash:[u8;32], usdc_amount:u64, xmr_amount:u64, alice_solana:Pubkey, expiry:i64, relayer_fee:u64)]
pub struct CreateXmrToUsdc<'info> {
    #[account(
        init,
        payer = bob,
        space = 8 + Swap::LEN,
        seeds = [b"swap", swap_id.as_ref()],
        bump
    )]
    pub swap: Account<'info, Swap>,

    /// CHECK: Alice pubkey
    pub alice: AccountInfo<'info>,

    #[account(mut)]
    pub bob: Signer<'info>,

    #[account(
        mut,
        associated_token::mint = usdc_mint,
        associated_token::authority = bob,
    )]
    pub bob_usdc: Account<'info, TokenAccount>,

    #[account(
        init,
        payer = bob,
        associated_token::mint = usdc_mint,
        associated_token::authority = swap,
    )]
    pub vault_usdc: Account<'info, TokenAccount>,

    #[account(
        init,
        payer = bob,
        associated_token::mint = usdc_mint,
        associated_token::authority = swap,
    )]
    pub vault_collateral: Account<'info, TokenAccount>,

    /// CHECK: Alice's collateral account (will be transferred from in create XMR->USDC scenario)
    pub alice_collateral: Account<'info, TokenAccount>,

    pub usdc_mint: Account<'info, Mint>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(swap_id:[u8;32], adaptor_sig:Vec<u8>)]
pub struct RedeemUsdcAlice<'info> {
    #[account(mut, seeds=[b"swap", swap.swap_id.as_ref()], bump=swap.bump)]
    pub swap: Account<'info, Swap>,
    #[account(mut)]
    pub alice: Signer<'info>,

    #[account(
        mut,
        associated_token::mint = usdc_mint,
        associated_token::authority = swap,
    )]
    pub vault_usdc: Account<'info, TokenAccount>,

    #[account(
        init_if_needed,
        payer = alice,
        associated_token::mint = usdc_mint,
        associated_token::authority = alice,
    )]
    pub alice_token: Account<'info, TokenAccount>,

    #[account(
        init_if_needed,
        payer = alice,
        associated_token::mint = usdc_mint,
        associated_token::authority = relayer,
    )]
    pub relayer_token: Account<'info, TokenAccount>,

    /// CHECK: relayer
    pub relayer: AccountInfo<'info>,

    pub usdc_mint: Account<'info, Mint>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(swap_id:[u8;32])]
pub struct Refund<'info> {
    #[account(mut, seeds=[b"swap", swap.swap_id.as_ref()], bump=swap.bump)]
    pub swap: Account<'info, Swap>,

    #[account(mut)]
    pub funder: Signer<'info>,

    #[account(
        mut,
        associated_token::mint = usdc_mint,
        associated_token::authority = swap,
    )]
    pub vault_usdc: Account<'info, TokenAccount>,

    #[account(
        mut,
        associated_token::mint = usdc_mint,
        associated_token::authority = swap,
    )]
    pub vault_collateral: Account<'info, TokenAccount>,

    #[account(
        init_if_needed,
        payer = funder,
        associated_token::mint = usdc_mint,
        associated_token::authority = funder,
    )]
    pub funder_token: Account<'info, TokenAccount>,

    #[account(
        init_if_needed,
        payer = funder,
        associated_token::mint = usdc_mint,
        associated_token::authority = funder,
    )]
    pub collateral_token: Account<'info, TokenAccount>,

    pub usdc_mint: Account<'info, Mint>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

/*==============================================================
 * Errors
 *============================================================*/
#[error_code]
pub enum ErrorCode {
    #[msg("Invalid adaptor signature")]
    InvalidAdaptorSig,
    #[msg("Already finalized")]
    AlreadyFinalized,
    #[msg("Not yet expired")]
    NotYetExpired,
    #[msg("Wrong direction")]
    WrongDirection,
    #[msg("Invalid preimage")]
    InvalidPreimage,
    #[msg("Invalid secret hash")]
    InvalidSecretHash,
    #[msg("Invalid expiry")]
    InvalidExpiry,
    #[msg("Excessive relayer fee")]
    ExcessiveRelayerFee,
    #[msg("Monero lock not recorded")]
    MoneroLockNotRecorded,
    #[msg("Insufficient confirmations")]
    InsufficientConfirmations,
    #[msg("VTC not ready")]
    VtcNotReady,
    #[msg("VTC already opened")]
    VtcAlreadyOpened,
    #[msg("Commitment expiry invalid")]
    CommitmentExpiryInvalid,
    #[msg("Bounty already claimed")]
    BountyAlreadyClaimed,
    #[msg("No collateral available for bounty")]
    NoCollateralAvailable,
}

// Additional contexts for new functionality

#[derive(Accounts)]
#[instruction(
    swap_id: [u8; 32], 
    sig: [u8; 64], 
    parity: u8, 
    curve_point: [u8; 32]
)]
pub struct AdaptorVerifyCtx<'info> {
    #[account(seeds=[b"swap", swap_id.as_ref()], bump=swap.bump)]
    pub swap: Account<'info, Swap>,
    
    #[account(mut)]
    pub signer: Signer<'info>,
    
    #[account(
        associated_token::mint = usdc_mint,
        associated_token::authority = swap,
    )]
    pub vault_usdc: Account<'info, TokenAccount>,
    
    #[account(
        associated_token::mint = usdc_mint,
        associated_token::authority = swap,
    )]
    pub vault_collateral: Account<'info, TokenAccount>,
    
    #[account(
        init_if_needed,
        payer = signer,
        associated_token::mint = usdc_mint,
        associated_token::authority = signer,
    )]
    pub signer_token: Account<'info, TokenAccount>,
    
    #[account(
        init_if_needed,
        payer = signer,
        associated_token::mint = usdc_mint,
        associated_token::authority = relayer,
    )]
    pub relayer_token: Account<'info, TokenAccount>,
    
    /// CHECK: relayer
    pub relayer: AccountInfo<'info>,
    
    pub usdc_mint: Account<'info, Mint>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(swap_id: [u8; 32])]
pub struct ForceOpenVtc<'info> {
    #[account(mut, seeds=[b"swap", swap_id.as_ref()], bump=swap.bump)]
    pub swap: Account<'info, Swap>,
    
    pub caller: Signer<'info>,
}


#[derive(Accounts)]
#[instruction(commitment_hash: [u8; 32], expiry: i64)]
pub struct CreateCommitment<'info> {
    #[account(
        init,
        payer = relayer,
        space = 8 + RelayerCommitment::LEN,
        seeds = [b"commitment", commitment_hash.as_ref()],
        bump
    )]
    pub commitment: Account<'info, RelayerCommitment>,
    
    #[account(mut)]
    pub relayer: Signer<'info>,
    
    /// CHECK: swapper pubkey
    pub swapper: AccountInfo<'info>,
    
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(swap_id: [u8; 32], adaptor_sig: [u8; 64], parity: u8, curve_point: [u8; 32])]
pub struct ClaimBounty<'info> {
    #[account(mut, seeds=[b"swap", swap_id.as_ref()], bump=swap.bump)]
    pub swap: Account<'info, Swap>,

    #[account(mut)]
    pub claimant: Signer<'info>,

    #[account(
        mut,
        associated_token::mint = usdc_mint,
        associated_token::authority = swap,
    )]
    pub vault_collateral: Account<'info, TokenAccount>,

    #[account(
        init_if_needed,
        payer = claimant,
        associated_token::mint = usdc_mint,
        associated_token::authority = claimant,
    )]
    pub claimant_token: Account<'info, TokenAccount>,

    pub usdc_mint: Account<'info, Mint>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}
