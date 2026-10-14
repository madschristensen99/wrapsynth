use anchor_lang::prelude::*;

declare_id!("EyhaxbtseCcbAc7W9PhVCyAWLt9EQ1rtPdK6aFPVzGka");

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
