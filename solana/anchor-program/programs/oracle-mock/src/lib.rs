use anchor_lang::prelude::*;

// Test-only program. Owns the mock Pyth PriceUpdateV2 accounts so the localnet
// suite can rewrite price/ema/publish_time mid-test (freshness is checked
// against the validator clock, which we cannot warp).
declare_id!("AWKqcPUtpsaPr19XpCq2ZD6Bk4HRGXnsYy9DUrZkLixY");

#[program]
pub mod oracle_mock {
    use super::*;

    /// Overwrite `data` bytes into `target` at `offset`. Only accounts owned by
    /// this program can be written, so this cannot touch real chain state — and
    /// this program is only ever deployed to the test validator.
    pub fn write_account(ctx: Context<WriteAccount>, offset: u64, data: Vec<u8>) -> Result<()> {
        let mut raw = ctx.accounts.target.try_borrow_mut_data()?;
        let start = offset as usize;
        let end = start.checked_add(data.len()).unwrap();
        require!(end <= raw.len(), OracleMockError::OutOfBounds);
        raw[start..end].copy_from_slice(&data);
        Ok(())
    }

    /// Test probe: run `sol_curve_multiscalar_mul` (Edwards) on `scalar`·G and
    /// write the compressed result into `target`[0..32]. Lets the suite verify
    /// the syscall's scalar semantics match curve25519-dalek off-chain.
    pub fn probe_scalar_mul(ctx: Context<WriteAccount>, scalar: [u8; 32]) -> Result<()> {
        const ED25519_BASE_COMPRESSED: [u8; 32] = [
            0x58, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66,
            0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66, 0x66,
            0x66, 0x66, 0x66, 0x66,
        ];
        let mut out = [0u8; 32];
        #[cfg(target_os = "solana")]
        {
            let rc = unsafe {
                anchor_lang::solana_program::syscalls::sol_curve_multiscalar_mul(
                    0, // CURVE25519_EDWARDS
                    scalar.as_ptr(),
                    ED25519_BASE_COMPRESSED.as_ptr(),
                    1,
                    out.as_mut_ptr(),
                )
            };
            msg!("probe rc={}", rc);
        }
        #[cfg(not(target_os = "solana"))]
        {
            let _ = scalar;
            msg!("probe unavailable on host");
        }
        let mut raw = ctx.accounts.target.try_borrow_mut_data()?;
        raw[..32].copy_from_slice(&out);
        Ok(())
    }
}

#[derive(Accounts)]
pub struct WriteAccount<'info> {
    /// CHECK: arbitrary oracle blob owned by this program — the owner
    /// constraint below is the entire safety boundary.
    #[account(mut, owner = crate::ID)]
    pub target: UncheckedAccount<'info>,
    pub payer: Signer<'info>,
}

#[error_code]
pub enum OracleMockError {
    #[msg("write range exceeds account data length")]
    OutOfBounds,
}
