use solana_program::{
    account_info::{next_account_info, AccountInfo},
    entrypoint,
    entrypoint::ProgramResult,
    msg,
    program_error::ProgramError,
    pubkey::Pubkey,
    sysvar::clock::Clock,
    sysvar::Sysvar,
};

entrypoint!(process_instruction);

#[repr(C)]
#[derive(Debug)]
pub struct MoneroBlockData {
    pub block_hash: [u8; 32],
    pub block_height: u64,
    pub timestamp: u64,
    pub tx_count: u32,
    pub merkle_root: [u8; 32],
}

pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    instruction_data: &[u8],
) -> ProgramResult {
    
    // Allow anyone to submit oracle data for now
    let account_info_iter = &mut accounts.iter();
    let oracle_account = next_account_info(account_info_iter)?;
    
    if instruction_data.len() < 64 {
        msg!("Invalid instruction data length");
        return Err(ProgramError::InvalidInstructionData);
    }
    
    // Deserialize the data
    let mut offset = 0;
    let mut block_hash = [0u8; 32];
    block_hash.copy_from_slice(&instruction_data[offset..offset + 32]);
    offset += 32;
    
    let block_height = u64::from_le_bytes([
        instruction_data[offset],
        instruction_data[offset + 1],
        instruction_data[offset + 2],
        instruction_data[offset + 3],
        instruction_data[offset + 4],
        instruction_data[offset + 5],
        instruction_data[offset + 6],
        instruction_data[offset + 7],
    ]);
    offset += 8;
    
    let timestamp = u64::from_le_bytes([
        instruction_data[offset],
        instruction_data[offset + 1],
        instruction_data[offset + 2],
        instruction_data[offset + 3],
        instruction_data[offset + 4],
        instruction_data[offset + 5],
        instruction_data[offset + 6],
        instruction_data[offset + 7],
    ]);
    offset += 8;
    
    let tx_count = u32::from_le_bytes([
        instruction_data[offset],
        instruction_data[offset + 1],
        instruction_data[offset + 2],
        instruction_data[offset + 3],
    ]);
    offset += 4;
    
    let mut merkle_root = [0u8; 32];
    merkle_root.copy_from_slice(&instruction_data[offset..offset + 32]);
    
    let clock = Clock::get()?;
    
    msg!(
        "Monero Oracle Data Updated - Height: {}, Hash: {:?}, Tx Count: {}",
        block_height,
        block_hash,
        tx_count
    );
    
    msg!(
        "Solana Slot: {}, Timestamp: {}",
        clock.slot,
        clock.unix_timestamp
    );
    
    // Store data in oracle account (for now just log)
    msg!("Oracle data submitted successfully");
    
    Ok(())
}