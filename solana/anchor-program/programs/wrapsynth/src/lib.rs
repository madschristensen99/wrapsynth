use anchor_lang::prelude::*;

declare_id!("EFRLChkEz8nDmkZs9n4ZUYazcN7E1QytKNDmtYm4vxEF");

#[program]
pub mod wrapsynth {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        msg!("Greetings from: {:?}", ctx.program_id);
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize {}
