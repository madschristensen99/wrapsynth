use verkle_xmr_bridge::{
    process_deposit,
    types::{
        CLSAGProof, KZGMultiproof, SpentKeyImagesSolana, VerkleNonMembershipProof, VerkleState,
        DepositData,
    },
};
use solana_program::program_error::ProgramError;

/// Create a minimal valid CLSAG proof for testing
fn create_test_clsag_proof(key_image: [u8; 32]) -> CLSAGProof {
    CLSAGProof {
        s_values: vec![[1u8; 32], [2u8; 32]],
        c1: [3u8; 32],
        key_image,
        auxiliary_key_image: [4u8; 32],
        ring_pubkeys: vec![[5u8; 32], [6u8; 32]],
        ring_commitments: vec![[7u8; 32], [8u8; 32]],
        pseudo_out: [9u8; 32],
        message: [10u8; 32],
    }
}

/// Create a minimal valid Verkle non-membership proof for testing
fn create_test_verkle_proof(key_image: [u8; 32], root: [u8; 64]) -> VerkleNonMembershipProof {
    // Verkle tree with width 256 has depth 32 (one byte per level)
    // So we need 33 commitments: root + 32 intermediate nodes
    let mut path_commitments = vec![root];
    for i in 1..=32 {
        path_commitments.push([i as u8; 64]);
    }

    VerkleNonMembershipProof {
        path_commitments,
        kzg_multiproof: KZGMultiproof {
            proof: [5u8; 64],
            evaluation_point: [6u8; 32],
        },
        terminal_value: None, // None = empty slot (proves non-membership)
        queried_key: key_image,
    }
}

#[test]
fn test_deposit_success() {
    // Setup
    let key_image = [42u8; 32];
    let verkle_root = [0u8; 64];

    let verkle_state = VerkleState {
        current_root: verkle_root,
        last_monero_block: 1000,
        relayer: [99u8; 32],
        relayer_bond: 1_000_000_000,
        pending_challenges: 0,
        update_timestamp: 1234567890,
    };

    let mut spent_key_images = SpentKeyImagesSolana {
        spent_images: vec![],
    };

    let deposit_data = DepositData {
        clsag_proof: create_test_clsag_proof(key_image),
        verkle_proof: create_test_verkle_proof(key_image, verkle_root),
        amount: 1_000_000, // 0.001 SOL
    };

    // Execute
    let result = process_deposit(&verkle_state, &mut spent_key_images, &deposit_data);

    // Verify
    assert!(result.is_ok(), "Deposit should succeed: {:?}", result);
    assert_eq!(result.unwrap(), 1_000_000);
    assert!(
        spent_key_images.is_spent(&key_image),
        "Key image should be marked as spent"
    );
}

#[test]
fn test_deposit_double_spend_prevention() {
    // Setup
    let key_image = [42u8; 32];
    let verkle_root = [0u8; 64];

    let verkle_state = VerkleState {
        current_root: verkle_root,
        last_monero_block: 1000,
        relayer: [99u8; 32],
        relayer_bond: 1_000_000_000,
        pending_challenges: 0,
        update_timestamp: 1234567890,
    };

    // Key image already spent on Solana
    let mut spent_key_images = SpentKeyImagesSolana {
        spent_images: vec![key_image],
    };

    let deposit_data = DepositData {
        clsag_proof: create_test_clsag_proof(key_image),
        verkle_proof: create_test_verkle_proof(key_image, verkle_root),
        amount: 1_000_000,
    };

    // Execute
    let result = process_deposit(&verkle_state, &mut spent_key_images, &deposit_data);

    // Verify - should fail because key image already used
    assert!(
        result.is_err(),
        "Should prevent double-spend on Solana side"
    );
    assert_eq!(result.unwrap_err(), ProgramError::InvalidInstructionData);
}

#[test]
fn test_deposit_verkle_proof_root_mismatch() {
    // Setup
    let key_image = [42u8; 32];
    let correct_root = [0u8; 64];
    let wrong_root = [99u8; 64];

    let verkle_state = VerkleState {
        current_root: correct_root,
        last_monero_block: 1000,
        relayer: [99u8; 32],
        relayer_bond: 1_000_000_000,
        pending_challenges: 0,
        update_timestamp: 1234567890,
    };

    let mut spent_key_images = SpentKeyImagesSolana {
        spent_images: vec![],
    };

    // Create proof with wrong root
    let deposit_data = DepositData {
        clsag_proof: create_test_clsag_proof(key_image),
        verkle_proof: create_test_verkle_proof(key_image, wrong_root),
        amount: 1_000_000,
    };

    // Execute
    let result = process_deposit(&verkle_state, &mut spent_key_images, &deposit_data);

    // Verify - should fail due to root mismatch
    assert!(
        result.is_err(),
        "Should reject proof with mismatched root"
    );
    assert_eq!(result.unwrap_err(), ProgramError::InvalidInstructionData);
}

#[test]
fn test_deposit_multiple_different_key_images() {
    // Setup
    let verkle_root = [0u8; 64];

    let verkle_state = VerkleState {
        current_root: verkle_root,
        last_monero_block: 1000,
        relayer: [99u8; 32],
        relayer_bond: 1_000_000_000,
        pending_challenges: 0,
        update_timestamp: 1234567890,
    };

    let mut spent_key_images = SpentKeyImagesSolana {
        spent_images: vec![],
    };

    // First deposit
    let key_image_1 = [42u8; 32];
    let deposit_data_1 = DepositData {
        clsag_proof: create_test_clsag_proof(key_image_1),
        verkle_proof: create_test_verkle_proof(key_image_1, verkle_root),
        amount: 1_000_000,
    };

    let result_1 = process_deposit(&verkle_state, &mut spent_key_images, &deposit_data_1);
    assert!(result_1.is_ok(), "First deposit should succeed");

    // Second deposit with different key image
    let key_image_2 = [43u8; 32];
    let deposit_data_2 = DepositData {
        clsag_proof: create_test_clsag_proof(key_image_2),
        verkle_proof: create_test_verkle_proof(key_image_2, verkle_root),
        amount: 2_000_000,
    };

    let result_2 = process_deposit(&verkle_state, &mut spent_key_images, &deposit_data_2);
    assert!(
        result_2.is_ok(),
        "Second deposit with different key image should succeed"
    );

    // Verify both key images are marked as spent
    assert!(spent_key_images.is_spent(&key_image_1));
    assert!(spent_key_images.is_spent(&key_image_2));
    assert_eq!(spent_key_images.spent_images.len(), 2);
}

#[test]
fn test_deposit_verkle_proof_with_occupied_terminal() {
    // Setup
    let key_image = [42u8; 32];
    let verkle_root = [0u8; 64];

    let verkle_state = VerkleState {
        current_root: verkle_root,
        last_monero_block: 1000,
        relayer: [99u8; 32],
        relayer_bond: 1_000_000_000,
        pending_challenges: 0,
        update_timestamp: 1234567890,
    };

    let mut spent_key_images = SpentKeyImagesSolana {
        spent_images: vec![],
    };

    // Create proof with occupied terminal (key image is in Monero spent set)
    let mut verkle_proof = create_test_verkle_proof(key_image, verkle_root);
    verkle_proof.terminal_value = Some(key_image); // Occupied = key image is spent on Monero

    let deposit_data = DepositData {
        clsag_proof: create_test_clsag_proof(key_image),
        verkle_proof,
        amount: 1_000_000,
    };

    // Execute
    let result = process_deposit(&verkle_state, &mut spent_key_images, &deposit_data);

    // Verify - should fail because key image is in Monero spent set
    assert!(
        result.is_err(),
        "Should reject deposit if key image is in Monero spent set"
    );
}

#[test]
fn test_deposit_different_amounts() {
    // Test various deposit amounts
    let test_amounts = vec![
        1,              // 1 lamport
        1_000_000,      // 0.001 SOL
        1_000_000_000,  // 1 SOL
        10_000_000_000, // 10 SOL
    ];

    let verkle_root = [0u8; 64];

    let verkle_state = VerkleState {
        current_root: verkle_root,
        last_monero_block: 1000,
        relayer: [99u8; 32],
        relayer_bond: 1_000_000_000,
        pending_challenges: 0,
        update_timestamp: 1234567890,
    };

    for (i, amount) in test_amounts.iter().enumerate() {
        let mut spent_key_images = SpentKeyImagesSolana {
            spent_images: vec![],
        };

        let key_image = [i as u8; 32];
        let deposit_data = DepositData {
            clsag_proof: create_test_clsag_proof(key_image),
            verkle_proof: create_test_verkle_proof(key_image, verkle_root),
            amount: *amount,
        };

        let result = process_deposit(&verkle_state, &mut spent_key_images, &deposit_data);

        assert!(
            result.is_ok(),
            "Deposit of {} lamports should succeed",
            amount
        );
        assert_eq!(result.unwrap(), *amount);
    }
}

#[test]
fn test_spent_key_images_helpers() {
    let mut spent = SpentKeyImagesSolana {
        spent_images: vec![],
    };

    let key1 = [1u8; 32];
    let key2 = [2u8; 32];

    // Initially not spent
    assert!(!spent.is_spent(&key1));
    assert!(!spent.is_spent(&key2));

    // Mark key1 as spent
    assert!(spent.mark_spent(key1).is_ok());
    assert!(spent.is_spent(&key1));
    assert!(!spent.is_spent(&key2));

    // Try to mark key1 again - should fail
    assert!(spent.mark_spent(key1).is_err());

    // Mark key2 as spent
    assert!(spent.mark_spent(key2).is_ok());
    assert!(spent.is_spent(&key1));
    assert!(spent.is_spent(&key2));

    assert_eq!(spent.spent_images.len(), 2);
}