use verkle_xmr_bridge::types::{KZGMultiproof, UpdateSpentSetData, VerkleState, VerkleUpdateProof};
use verkle_xmr_bridge::process_update_spent_set;
use solana_program::program_error::ProgramError;

#[test]
fn test_update_spent_set_success() {
    // Create initial state
    let relayer_pubkey = [42u8; 32];
    let mut verkle_state = VerkleState {
        current_root: [0u8; 64],
        last_monero_block: 0,
        relayer: relayer_pubkey,
        relayer_bond: 1_000_000_000,
        pending_challenges: 0,
        update_timestamp: 0,
    };

    // Create update data
    let update_data = UpdateSpentSetData {
        new_root: [1u8; 64],
        block_range: (1, 100),
        new_key_images: vec![[42u8; 32], [43u8; 32]],
        proof: VerkleUpdateProof {
            insertion_proofs: vec![KZGMultiproof {
                proof: [5u8; 64],
                evaluation_point: [6u8; 32],
            }],
            intermediate_roots: vec![[7u8; 64]],
        },
    };

    let current_timestamp = 1234567890;

    // Process update
    let result = process_update_spent_set(
        &mut verkle_state,
        &relayer_pubkey,
        &update_data,
        current_timestamp,
    );

    // Verify success (note: proof verification is stubbed out in tests)
    assert!(result.is_ok(), "Update should succeed: {:?}", result);
    assert_eq!(verkle_state.current_root, [1u8; 64]);
    assert_eq!(verkle_state.last_monero_block, 100);
    assert_eq!(verkle_state.update_timestamp, current_timestamp);
}

#[test]
fn test_update_spent_set_unauthorized_relayer() {
    // Create initial state with authorized relayer
    let authorized_relayer = [42u8; 32];
    let mut verkle_state = VerkleState {
        current_root: [0u8; 64],
        last_monero_block: 0,
        relayer: authorized_relayer,
        relayer_bond: 1_000_000_000,
        pending_challenges: 0,
        update_timestamp: 0,
    };

    // Create update data
    let update_data = UpdateSpentSetData {
        new_root: [1u8; 64],
        block_range: (1, 100),
        new_key_images: vec![[42u8; 32]],
        proof: VerkleUpdateProof {
            insertion_proofs: vec![],
            intermediate_roots: vec![],
        },
    };

    // Try to update with UNAUTHORIZED relayer
    let unauthorized_relayer = [99u8; 32];
    let result = process_update_spent_set(
        &mut verkle_state,
        &unauthorized_relayer,
        &update_data,
        1234567890,
    );

    // Should fail with unauthorized relayer
    assert!(result.is_err(), "Should fail with unauthorized relayer");
    assert_eq!(result.unwrap_err(), ProgramError::InvalidAccountData);
}

#[test]
fn test_update_spent_set_invalid_block_range() {
    // Create initial state
    let relayer_pubkey = [42u8; 32];
    let mut verkle_state = VerkleState {
        current_root: [0u8; 64],
        last_monero_block: 0,
        relayer: relayer_pubkey,
        relayer_bond: 1_000_000_000,
        pending_challenges: 0,
        update_timestamp: 0,
    };

    // Create update data with INVALID block range (start > end)
    let update_data = UpdateSpentSetData {
        new_root: [1u8; 64],
        block_range: (100, 50), // Invalid: start > end
        new_key_images: vec![[42u8; 32]],
        proof: VerkleUpdateProof {
            insertion_proofs: vec![],
            intermediate_roots: vec![],
        },
    };

    // Process update
    let result = process_update_spent_set(
        &mut verkle_state,
        &relayer_pubkey,
        &update_data,
        1234567890,
    );

    // Should fail with invalid block range
    assert!(result.is_err(), "Should fail with invalid block range");
    assert_eq!(result.unwrap_err(), ProgramError::InvalidInstructionData);
}

#[test]
fn test_update_spent_set_non_sequential_blocks() {
    // Create initial state
    let relayer_pubkey = [42u8; 32];
    let mut verkle_state = VerkleState {
        current_root: [0u8; 64],
        last_monero_block: 0,
        relayer: relayer_pubkey,
        relayer_bond: 1_000_000_000,
        pending_challenges: 0,
        update_timestamp: 0,
    };

    // First update: blocks 1-100
    let update_data_1 = UpdateSpentSetData {
        new_root: [1u8; 64],
        block_range: (1, 100),
        new_key_images: vec![[42u8; 32]],
        proof: VerkleUpdateProof {
            insertion_proofs: vec![KZGMultiproof {
                proof: [5u8; 64],
                evaluation_point: [6u8; 32],
            }],
            intermediate_roots: vec![[7u8; 64]],
        },
    };

    let result_1 = process_update_spent_set(
        &mut verkle_state,
        &relayer_pubkey,
        &update_data_1,
        1234567890,
    );
    assert!(result_1.is_ok(), "First update should succeed");

    // Second update: blocks 102-200 (gap from 101)
    let update_data_2 = UpdateSpentSetData {
        new_root: [2u8; 64],
        block_range: (102, 200), // Gap: should be 101
        new_key_images: vec![[43u8; 32]],
        proof: VerkleUpdateProof {
            insertion_proofs: vec![KZGMultiproof {
                proof: [8u8; 64],
                evaluation_point: [9u8; 32],
            }],
            intermediate_roots: vec![[10u8; 64]],
        },
    };

    let result_2 = process_update_spent_set(
        &mut verkle_state,
        &relayer_pubkey,
        &update_data_2,
        1234567891,
    );

    // Second update should fail (non-sequential)
    assert!(
        result_2.is_err(),
        "Should fail with non-sequential blocks"
    );
    assert_eq!(result_2.unwrap_err(), ProgramError::InvalidInstructionData);
}

#[test]
fn test_update_spent_set_sequential_updates() {
    // Create initial state
    let relayer_pubkey = [42u8; 32];
    let mut verkle_state = VerkleState {
        current_root: [0u8; 64],
        last_monero_block: 0,
        relayer: relayer_pubkey,
        relayer_bond: 1_000_000_000,
        pending_challenges: 0,
        update_timestamp: 0,
    };

    // First update: blocks 1-100
    let update_data_1 = UpdateSpentSetData {
        new_root: [1u8; 64],
        block_range: (1, 100),
        new_key_images: vec![[42u8; 32]],
        proof: VerkleUpdateProof {
            insertion_proofs: vec![KZGMultiproof {
                proof: [5u8; 64],
                evaluation_point: [6u8; 32],
            }],
            intermediate_roots: vec![[7u8; 64]],
        },
    };

    let result_1 = process_update_spent_set(
        &mut verkle_state,
        &relayer_pubkey,
        &update_data_1,
        1234567890,
    );
    assert!(result_1.is_ok(), "First update should succeed");

    // Second update: blocks 101-200 (sequential)
    let update_data_2 = UpdateSpentSetData {
        new_root: [2u8; 64],
        block_range: (101, 200), // Correctly sequential
        new_key_images: vec![[43u8; 32]],
        proof: VerkleUpdateProof {
            insertion_proofs: vec![KZGMultiproof {
                proof: [8u8; 64],
                evaluation_point: [9u8; 32],
            }],
            intermediate_roots: vec![[10u8; 64]],
        },
    };

    let result_2 = process_update_spent_set(
        &mut verkle_state,
        &relayer_pubkey,
        &update_data_2,
        1234567891,
    );
    assert!(
        result_2.is_ok(),
        "Second update should succeed with sequential blocks"
    );

    // Verify final state
    assert_eq!(verkle_state.current_root, [2u8; 64]);
    assert_eq!(verkle_state.last_monero_block, 200);
    assert_eq!(verkle_state.update_timestamp, 1234567891);
}

#[test]
fn test_update_spent_set_can_start_at_any_block() {
    // Create initial state at block 0
    let relayer_pubkey = [42u8; 32];
    let mut verkle_state = VerkleState {
        current_root: [0u8; 64],
        last_monero_block: 0,
        relayer: relayer_pubkey,
        relayer_bond: 1_000_000_000,
        pending_challenges: 0,
        update_timestamp: 0,
    };

    // Bridge can start at any block height (e.g., current Monero block)
    // This allows syncing from the current chain state without processing all history
    let update_data = UpdateSpentSetData {
        new_root: [1u8; 64],
        block_range: (3000000, 3000100), // Can start at current Monero block
        new_key_images: vec![[42u8; 32]],
        proof: VerkleUpdateProof {
            insertion_proofs: vec![KZGMultiproof {
                proof: [5u8; 64],
                evaluation_point: [6u8; 32],
            }],
            intermediate_roots: vec![[7u8; 64]],
        },
    };

    let result = process_update_spent_set(
        &mut verkle_state,
        &relayer_pubkey,
        &update_data,
        1234567890,
    );

    // Should succeed - can start at any block from initial state
    assert!(result.is_ok(), "Should allow starting at any block from initial state: {:?}", result);
    assert_eq!(verkle_state.last_monero_block, 3000100);
}