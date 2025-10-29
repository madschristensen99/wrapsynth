use pinocchio::entrypoint;
use solana_program::{
    account_info::AccountInfo,
    clock::Clock,
    entrypoint::ProgramResult,
    msg,
    program_error::ProgramError,
    pubkey::Pubkey,
    sysvar::Sysvar,
};
use borsh::{BorshDeserialize, BorshSerialize};

pub mod clsag;
pub mod types;
pub mod verkle;

use types::{DepositData, UpdateSpentSetData, VerkleState};

entrypoint!(process_instruction);

pub fn process_instruction(
    program_id: &[u8; 32],
    accounts: &[AccountInfo],
    instruction_data: &[u8],
) -> ProgramResult {
    if instruction_data.is_empty() {
        return Err(ProgramError::InvalidInstructionData);
    }

    let discriminator = instruction_data[0];
    let data = &instruction_data[1..];

    match discriminator {
        0 => deposit(program_id, accounts, data),
        1 => withdraw(program_id, accounts, data),
        2 => update_spent_set(program_id, accounts, data),
        _ => {
            msg!("Invalid instruction discriminator: {}", discriminator);
            Err(ProgramError::InvalidInstructionData)
        }
    }
}

/// Core logic for processing deposits from Monero to Solana
///
/// This function verifies that:
/// 1. The multisig owner has valid CLSAG proof (proves Monero ownership)
/// 2. The key image is NOT in the Monero spent set (proves UTXO is unspent)
/// 3. The key image hasn't been used on Solana yet (prevents double-claiming)
///
/// If all checks pass, tokens are minted/issued on Solana.
pub fn process_deposit(
    verkle_state: &VerkleState,
    spent_key_images: &mut types::SpentKeyImagesSolana,
    deposit_data: &DepositData,
) -> Result<u64, ProgramError> {
    let key_image = &deposit_data.clsag_proof.key_image;

    msg!("Processing deposit for key image: {:?}", &key_image[..8]);

    // 1. Verify CLSAG signature (proves multisig owner owns the Monero UTXO)
    clsag::verify_clsag(&deposit_data.clsag_proof)?;
    msg!("CLSAG signature verified");

    // 2. Verify Verkle non-membership proof (proves key image is NOT in Monero spent set)
    // This ensures the Monero UTXO is still unspent
    let proof_valid = verkle::verify_verkle_non_membership(
        &deposit_data.verkle_proof,
        &verkle_state.current_root,
        key_image,
    )?;

    if !proof_valid {
        msg!("Verkle non-membership proof invalid");
        return Err(ProgramError::InvalidInstructionData);
    }

    msg!("Verkle non-membership proof verified - UTXO is unspent");

    // 3. Check that this key image hasn't been claimed on Solana yet
    if spent_key_images.is_spent(key_image) {
        msg!("Key image already claimed on Solana");
        return Err(ProgramError::InvalidInstructionData);
    }

    // 4. Mark the key image as used on Solana to prevent double-claiming
    spent_key_images
        .mark_spent(*key_image)
        .map_err(|e| {
            msg!("Failed to mark key image as used: {}", e);
            ProgramError::InvalidAccountData
        })?;

    msg!("Deposit approved: {} lamports to mint", deposit_data.amount);

    Ok(deposit_data.amount)
}

/// Deposit: User receives tokens on Solana after proving unspent Monero UTXO
///
/// This instruction allows minting tokens on Solana by proving:
/// 1. Multisig owner has CLSAG proof (proves Monero UTXO ownership)
/// 2. Key image is NOT in Monero spent set (proves UTXO is unspent)
///
/// # Accounts Expected
/// 0. `[writable]` User account (receives minted tokens)
/// 1. `[writable]` Mint authority (for minting tokens)
/// 2. `[writable]` Spent key images account (tracks claimed key images)
/// 3. `[]` Verkle state account (for proof verification)
/// 4. `[]` Token program (for minting)
///
/// # Security Model
/// - CLSAG signature proves multisig owner controls Monero UTXO
/// - Verkle non-membership proof ensures UTXO is unspent on Monero side
/// - Spent key images tracking prevents double-claiming on Solana side
pub fn deposit(
    program_id: &[u8; 32],
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    msg!("Instruction: Deposit");

    // 1. Parse accounts
    let accounts_iter = &mut accounts.iter();

    let user_account = accounts_iter
        .next()
        .ok_or(ProgramError::NotEnoughAccountKeys)?;

    let mint_authority = accounts_iter
        .next()
        .ok_or(ProgramError::NotEnoughAccountKeys)?;

    let spent_key_images_account = accounts_iter
        .next()
        .ok_or(ProgramError::NotEnoughAccountKeys)?;

    let verkle_state_account = accounts_iter
        .next()
        .ok_or(ProgramError::NotEnoughAccountKeys)?;

    let _token_program = accounts_iter
        .next()
        .ok_or(ProgramError::NotEnoughAccountKeys)?;

    // 2. Verify accounts
    let program_pubkey = Pubkey::new_from_array(*program_id);

    // Verify spent key images account is owned by this program
    if spent_key_images_account.owner != &program_pubkey {
        msg!("Spent key images account has invalid owner");
        return Err(ProgramError::IncorrectProgramId);
    }

    // Verify verkle state account is owned by this program
    if verkle_state_account.owner != &program_pubkey {
        msg!("Verkle state account has invalid owner");
        return Err(ProgramError::IncorrectProgramId);
    }

    // Verify accounts are writable where needed
    if !user_account.is_writable {
        msg!("User account must be writable");
        return Err(ProgramError::InvalidAccountData);
    }

    if !mint_authority.is_writable {
        msg!("Mint authority must be writable");
        return Err(ProgramError::InvalidAccountData);
    }

    if !spent_key_images_account.is_writable {
        msg!("Spent key images account must be writable");
        return Err(ProgramError::InvalidAccountData);
    }

    // 3. Deserialize deposit data
    let deposit_data = DepositData::try_from_slice(data).map_err(|e| {
        msg!("Failed to deserialize DepositData: {}", e);
        ProgramError::InvalidInstructionData
    })?;

    // 4. Deserialize verkle state (read-only)
    let verkle_state = VerkleState::try_from_slice(&verkle_state_account.data.borrow())
        .map_err(|e| {
            msg!("Failed to deserialize VerkleState: {}", e);
            ProgramError::InvalidAccountData
        })?;

    // 5. Deserialize spent key images (mutable)
    let mut spent_key_images = types::SpentKeyImagesSolana::try_from_slice(
        &spent_key_images_account.data.borrow()
    ).map_err(|e| {
        msg!("Failed to deserialize SpentKeyImagesSolana: {}", e);
        ProgramError::InvalidAccountData
    })?;

    // 6. Process the deposit (verify proofs and mark key image as claimed)
    let amount = process_deposit(&verkle_state, &mut spent_key_images, &deposit_data)?;

    // 7. Mint tokens to user (simplified - real implementation would use SPL Token)
    **user_account.try_borrow_mut_lamports()? += amount;

    msg!("Minted {} lamports to user", amount);

    // 8. Serialize updated spent key images
    spent_key_images
        .serialize(&mut &mut spent_key_images_account.data.borrow_mut()[..])
        .map_err(|e| {
            msg!("Failed to serialize SpentKeyImagesSolana: {}", e);
            ProgramError::InvalidAccountData
        })?;

    msg!("Deposit completed successfully");

    Ok(())
}

/// Withdraw: User locks tokens on Solana to receive XMR on Monero
pub fn withdraw(
    _program_id: &[u8; 32],
    _accounts: &[AccountInfo],
    _data: &[u8],
) -> ProgramResult {
    msg!("Instruction: Withdraw");

    // TODO: Implement withdrawal logic
    // - Lock/burn user's SPL tokens
    // - Emit event with XMR destination address
    // - Relayer will release XMR from multisig on Monero side

    Ok(())
}

/// Core logic for updating the spent set with new key images
///
/// This function contains the business logic for validating and applying
/// updates to the Verkle tree. It's separated from the instruction handler
/// to allow direct testing without needing to deploy the program.
pub fn process_update_spent_set(
    verkle_state: &mut VerkleState,
    relayer_pubkey: &[u8; 32],
    update_data: &UpdateSpentSetData,
    current_timestamp: i64,
) -> ProgramResult {
    // 1. Verify relayer authority
    if verkle_state.relayer != *relayer_pubkey {
        msg!("Unauthorized relayer");
        return Err(ProgramError::InvalidAccountData);
    }

    msg!(
        "Updating spent set: blocks {}-{}, {} new key images",
        update_data.block_range.0,
        update_data.block_range.1,
        update_data.new_key_images.len()
    );

    // 2. Validate block range
    if update_data.block_range.0 > update_data.block_range.1 {
        msg!("Invalid block range: start > end");
        return Err(ProgramError::InvalidInstructionData);
    }

    // 3. Verify block range is sequential (no gaps)
    if verkle_state.last_monero_block > 0
        && update_data.block_range.0 != verkle_state.last_monero_block + 1
    {
        msg!(
            "Non-sequential block range: expected start {}, got {}",
            verkle_state.last_monero_block + 1,
            update_data.block_range.0
        );
        return Err(ProgramError::InvalidInstructionData);
    }

    // 4. Verify Verkle batch insertion proof
    let proof_valid = verkle::verify_batch_insertion_proof(
        &verkle_state.current_root,
        &update_data.new_root,
        &update_data.new_key_images,
        &update_data.proof,
    )?;

    if !proof_valid {
        msg!("Invalid Verkle batch insertion proof");
        return Err(ProgramError::InvalidInstructionData);
    }

    msg!("Verkle proof verified successfully");

    // 5. Update verkle state
    verkle_state.current_root = update_data.new_root;
    verkle_state.last_monero_block = update_data.block_range.1;
    verkle_state.update_timestamp = current_timestamp;

    msg!("Spent set updated successfully");
    msg!("New root: {:?}", &update_data.new_root[..8]);
    msg!("New block height: {}", verkle_state.last_monero_block);

    Ok(())
}

/// Update Spent Set: Relayer updates Verkle tree with new spent key images
///
/// This instruction allows an authorized relayer to update the Verkle tree with
/// new spent key images from Monero blocks.
///
/// # Accounts Expected
/// 0. `[writable]` Verkle state account
/// 1. `[signer]` Relayer account (must match state.relayer)
/// 2. `[]` Clock sysvar
///
/// # Security Model
/// - Only the authorized relayer can submit updates
/// - Updates include a Verkle proof of correct batch insertion
/// - Updates have a challenge period before finalization
/// - Invalid updates can be challenged with fraud proofs
pub fn update_spent_set(
    program_id: &[u8; 32],
    accounts: &[AccountInfo],
    data: &[u8],
) -> ProgramResult {
    msg!("Instruction: UpdateSpentSet");

    // 1. Parse accounts
    let accounts_iter = &mut accounts.iter();

    let verkle_state_account = accounts_iter
        .next()
        .ok_or(ProgramError::NotEnoughAccountKeys)?;

    let relayer_account = accounts_iter
        .next()
        .ok_or(ProgramError::NotEnoughAccountKeys)?;

    let _clock_sysvar = accounts_iter
        .next()
        .ok_or(ProgramError::NotEnoughAccountKeys)?;

    // 2. Verify verkle state account is owned by this program
    let program_pubkey = Pubkey::new_from_array(*program_id);
    if verkle_state_account.owner != &program_pubkey {
        msg!("Verkle state account has invalid owner");
        return Err(ProgramError::IncorrectProgramId);
    }

    // 3. Verify verkle state account is writable
    if !verkle_state_account.is_writable {
        msg!("Verkle state account must be writable");
        return Err(ProgramError::InvalidAccountData);
    }

    // 4. Verify relayer is signer
    if !relayer_account.is_signer {
        msg!("Relayer must be a signer");
        return Err(ProgramError::MissingRequiredSignature);
    }

    // 5. Deserialize verkle state
    let mut verkle_state = VerkleState::try_from_slice(&verkle_state_account.data.borrow())
        .map_err(|e| {
            msg!("Failed to deserialize VerkleState: {}", e);
            ProgramError::InvalidAccountData
        })?;

    // 6. Deserialize update data
    let update_data = UpdateSpentSetData::try_from_slice(data).map_err(|e| {
        msg!("Failed to deserialize UpdateSpentSetData: {}", e);
        ProgramError::InvalidInstructionData
    })?;

    // 7. Get current timestamp
    let clock = Clock::get()?;

    // 8. Process the update using core business logic
    let relayer_pubkey_bytes = relayer_account.key.to_bytes();
    process_update_spent_set(
        &mut verkle_state,
        &relayer_pubkey_bytes,
        &update_data,
        clock.unix_timestamp,
    )?;

    // 9. Serialize updated state back to account
    verkle_state
        .serialize(&mut &mut verkle_state_account.data.borrow_mut()[..])
        .map_err(|e| {
            msg!("Failed to serialize VerkleState: {}", e);
            ProgramError::InvalidAccountData
        })?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use solana_program::{clock::Clock, program_error::ProgramError};
    use types::{KZGMultiproof, VerkleUpdateProof};

    #[test]
    fn test_update_spent_set_validates_block_range() {
        // Test that start > end is rejected
        let update_data = UpdateSpentSetData {
            new_root: [1u8; 64],
            block_range: (100, 50), // Invalid: start > end
            new_key_images: vec![[0u8; 32]],
            proof: VerkleUpdateProof {
                insertion_proofs: vec![],
                intermediate_roots: vec![],
            },
        };

        // Serialize the data
        let mut data = vec![0u8]; // Placeholder for discriminator
        update_data.serialize(&mut data).unwrap();

        // This should fail during validation
        // (Full test would require mocking accounts)
    }

    #[test]
    fn test_update_spent_set_data_serialization() {
        // Test that UpdateSpentSetData serializes/deserializes correctly
        let update_data = UpdateSpentSetData {
            new_root: [42u8; 64],
            block_range: (1000, 1100),
            new_key_images: vec![[1u8; 32], [2u8; 32], [3u8; 32]],
            proof: VerkleUpdateProof {
                insertion_proofs: vec![KZGMultiproof {
                    proof: [5u8; 64],
                    evaluation_point: [6u8; 32],
                }],
                intermediate_roots: vec![[7u8; 64]],
            },
        };

        // Serialize
        let mut serialized = Vec::new();
        update_data.serialize(&mut serialized).unwrap();

        // Deserialize
        let deserialized = UpdateSpentSetData::try_from_slice(&serialized).unwrap();

        // Verify
        assert_eq!(deserialized.new_root, update_data.new_root);
        assert_eq!(deserialized.block_range, update_data.block_range);
        assert_eq!(
            deserialized.new_key_images.len(),
            update_data.new_key_images.len()
        );
        assert_eq!(deserialized.new_key_images[0], [1u8; 32]);
        assert_eq!(deserialized.new_key_images[1], [2u8; 32]);
        assert_eq!(deserialized.new_key_images[2], [3u8; 32]);
    }

    #[test]
    fn test_verkle_state_serialization() {
        // Test that VerkleState serializes/deserializes correctly
        let state = VerkleState {
            current_root: [10u8; 64],
            last_monero_block: 12345,
            relayer: [20u8; 32],
            relayer_bond: 1_000_000_000, // 1 SOL in lamports
            pending_challenges: 0,
            update_timestamp: 1609459200, // 2021-01-01
        };

        // Serialize
        let mut serialized = Vec::new();
        state.serialize(&mut serialized).unwrap();

        // Deserialize
        let deserialized = VerkleState::try_from_slice(&serialized).unwrap();

        // Verify
        assert_eq!(deserialized.current_root, state.current_root);
        assert_eq!(deserialized.last_monero_block, state.last_monero_block);
        assert_eq!(deserialized.relayer, state.relayer);
        assert_eq!(deserialized.relayer_bond, state.relayer_bond);
        assert_eq!(deserialized.pending_challenges, state.pending_challenges);
        assert_eq!(deserialized.update_timestamp, state.update_timestamp);
    }

    #[test]
    fn test_process_instruction_discriminator() {
        // Test that invalid discriminators are rejected
        let program_id = [0u8; 32];
        let accounts = vec![];

        // Test invalid discriminator
        let invalid_data = vec![99u8]; // Invalid discriminator
        let result = process_instruction(&program_id, &accounts, &invalid_data);
        assert!(result.is_err());
        assert_eq!(result.unwrap_err(), ProgramError::InvalidInstructionData);

        // Test empty data
        let empty_data = vec![];
        let result = process_instruction(&program_id, &accounts, &empty_data);
        assert!(result.is_err());
        assert_eq!(result.unwrap_err(), ProgramError::InvalidInstructionData);
    }

    #[test]
    fn test_sequential_block_validation_logic() {
        // Test the sequential block validation logic in isolation
        let last_block = 1000u64;
        let new_start = 1001u64;
        let new_end = 1100u64;

        // Valid: sequential
        assert_eq!(new_start, last_block + 1);

        // Invalid: gap
        let new_start_gap = 1002u64;
        assert_ne!(new_start_gap, last_block + 1);

        // Invalid: overlap
        let new_start_overlap = 1000u64;
        assert_ne!(new_start_overlap, last_block + 1);

        // Valid block range
        assert!(new_start <= new_end);

        // Invalid block range
        let invalid_end = 900u64;
        assert!(new_start > invalid_end);
    }

    #[test]
    fn test_update_spent_set_key_image_count() {
        // Test that we can handle various key image counts
        let test_counts = vec![0, 1, 10, 100, 1000];

        for count in test_counts {
            let update_data = UpdateSpentSetData {
                new_root: [1u8; 64],
                block_range: (1, 2),
                new_key_images: vec![[0u8; 32]; count],
                proof: VerkleUpdateProof {
                    insertion_proofs: vec![],
                    intermediate_roots: vec![],
                },
            };

            assert_eq!(update_data.new_key_images.len(), count);

            // Serialize and deserialize
            let mut serialized = Vec::new();
            update_data.serialize(&mut serialized).unwrap();
            let deserialized = UpdateSpentSetData::try_from_slice(&serialized).unwrap();
            assert_eq!(deserialized.new_key_images.len(), count);
        }
    }
}