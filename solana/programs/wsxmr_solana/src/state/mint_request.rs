use anchor_lang::prelude::*;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum MintStatus {
    Invalid = 0,
    Pending = 1,
    Ready = 2,
    Completed = 3,
    Cancelled = 4,
}

#[account]
pub struct MintRequest {
    pub request_id: [u8; 32],
    pub lp_vault: Pubkey,
    pub initiator: Pubkey,
    pub recipient: Pubkey,
    pub wsxmr_amount: u64,
    pub fee_amount: u64,
    pub claim_commitment: [u8; 32],
    pub timeout: i64,
    pub griefing_deposit: u64,
    pub status: u8,
}

impl MintRequest {
    pub const LEN: usize = 8 + 32 + 32 + 32 + 32 + 8 + 8 + 32 + 8 + 8 + 1;
    pub const SEED_PREFIX: &'static [u8] = b"mint_request";
    
    pub fn get_status(&self) -> MintStatus {
        match self.status {
            1 => MintStatus::Pending,
            2 => MintStatus::Ready,
            3 => MintStatus::Completed,
            4 => MintStatus::Cancelled,
            _ => MintStatus::Invalid,
        }
    }
    
    pub fn set_status(&mut self, status: MintStatus) {
        self.status = status as u8;
    }
}
