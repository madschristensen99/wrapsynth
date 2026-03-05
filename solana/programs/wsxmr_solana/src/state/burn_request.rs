use anchor_lang::prelude::*;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum BurnStatus {
    Invalid = 0,
    Requested = 1,
    Proposed = 2,
    Committed = 3,
    Completed = 4,
    Slashed = 5,
    Cancelled = 6,
}

#[account]
pub struct BurnRequest {
    pub request_id: [u8; 32],
    pub user: Pubkey,
    pub lp_vault: Pubkey,
    pub wsxmr_amount: u64,
    pub locked_collateral: u64,
    pub reward_collateral: u64,
    pub secret_hash: [u8; 32],
    pub deadline: i64,
    pub status: u8,
}

impl BurnRequest {
    pub const LEN: usize = 8 + 32 + 32 + 32 + 8 + 8 + 8 + 32 + 8 + 1;
    pub const SEED_PREFIX: &'static [u8] = b"burn_request";
    
    pub fn get_status(&self) -> BurnStatus {
        match self.status {
            1 => BurnStatus::Requested,
            2 => BurnStatus::Proposed,
            3 => BurnStatus::Committed,
            4 => BurnStatus::Completed,
            5 => BurnStatus::Slashed,
            6 => BurnStatus::Cancelled,
            _ => BurnStatus::Invalid,
        }
    }
    
    pub fn set_status(&mut self, status: BurnStatus) {
        self.status = status as u8;
    }
}
