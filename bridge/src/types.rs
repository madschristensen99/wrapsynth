use borsh::{BorshDeserialize, BorshSerialize};

// ============================================================================
// PROOF STRUCTURES
// ============================================================================

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug)]
pub struct VerkleNonMembershipProof {
    /// Commitments along path from root to queried position
    pub path_commitments: Vec<[u8; 64]>, // G1 points

    /// KZG multiproof for all parent-child openings
    pub kzg_multiproof: KZGMultiproof,

    /// Terminal value at the queried position (None if empty, Some(key) if occupied)
    pub terminal_value: Option<[u8; 32]>,

    /// The key image being queried
    pub queried_key: [u8; 32],
}

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug)]
pub struct KZGMultiproof {
    /// Single KZG proof for batch verification
    pub proof: [u8; 64], // G1 point

    /// Random evaluation point (Fiat-Shamir challenge)
    pub evaluation_point: [u8; 32],
}

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug)]
pub struct VerkleUpdateProof {
    /// Proof that batch insertion was performed correctly
    pub insertion_proofs: Vec<KZGMultiproof>,

    /// Intermediate roots (for verifying incremental updates)
    pub intermediate_roots: Vec<[u8; 64]>,
}

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug)]
pub struct VerkleUpdateFraudProof {
    pub fraud_type: FraudType,
    pub previous_valid_root: [u8; 64],
    pub previous_block_height: u64,
    pub evidence: Vec<u8>, // Type-specific evidence
}

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug)]
pub enum FraudType {
    IncludedNonSpent,
    OmittedSpent,
    InvalidTransition,
}

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug)]
pub struct CLSAGProof {
    pub s_values: Vec<[u8; 32]>,
    pub c1: [u8; 32],
    pub key_image: [u8; 32],
    pub auxiliary_key_image: [u8; 32],
    pub ring_pubkeys: Vec<[u8; 32]>,
    pub ring_commitments: Vec<[u8; 32]>,
    pub pseudo_out: [u8; 32],
    pub message: [u8; 32],
}

// ============================================================================
// STATE STRUCTURES
// ============================================================================

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug)]
pub struct VerkleState {
    /// Current Verkle tree root commitment (G1 point)
    pub current_root: [u8; 64],

    /// Last synced Monero block height
    pub last_monero_block: u64,

    /// Active relayer pubkey
    pub relayer: [u8; 32],

    /// Relayer's bonded amount
    pub relayer_bond: u64,

    /// Number of pending challenges
    pub pending_challenges: u8,

    /// Timestamp of last update
    pub update_timestamp: i64,
}

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug)]
pub struct BridgeConfig {
    /// Challenge period in seconds (e.g., 7 days = 604800)
    pub challenge_period: i64,

    /// Minimum relayer bond in lamports
    pub min_relayer_bond: u64,

    /// Bridge fee in lamports
    pub bridge_fee: u64,

    /// Verkle tree width (typically 256)
    pub verkle_width: u16,
}

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug)]
pub struct KZGSetupParams {
    /// G1 generator
    pub g1_generator: [u8; 64],

    /// G2 generator
    pub g2_generator: [u8; 128],

    /// [τ]₂ in G2 (from trusted setup)
    pub g2_tau: [u8; 128],

    /// Additional powers of τ (if needed)
    pub tau_powers_g1: Vec<[u8; 64]>,
}

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug)]
pub struct RelayerAccount {
    pub relayer: [u8; 32],
    pub bonded_amount: u64,
    pub successful_updates: u64,
    pub slashed_count: u64,
}

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug)]
pub struct SpentKeyImagesSolana {
    /// Track key images used on Solana side
    pub spent_images: Vec<[u8; 32]>,
}

impl SpentKeyImagesSolana {
    pub fn is_spent(&self, key_image: &[u8; 32]) -> bool {
        self.spent_images.contains(key_image)
    }

    pub fn mark_spent(&mut self, key_image: [u8; 32]) -> Result<(), &'static str> {
        if self.is_spent(&key_image) {
            return Err("Key image already spent on Solana");
        }
        self.spent_images.push(key_image);
        Ok(())
    }
}

// ============================================================================
// DEPOSIT/WITHDRAWAL DATA
// ============================================================================

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug)]
pub struct DepositData {
    /// CLSAG signature proving Monero UTXO ownership
    pub clsag_proof: CLSAGProof,

    /// Verkle non-membership proof (key image NOT in spent set = unspent UTXO)
    pub verkle_proof: VerkleNonMembershipProof,

    /// Amount to mint on Solana
    pub amount: u64,
}

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug)]
pub struct WithdrawData {
    /// Amount to lock/burn on Solana
    pub amount: u64,

    /// Monero destination address (where XMR will be sent)
    pub xmr_destination: [u8; 64],
}

#[derive(BorshSerialize, BorshDeserialize, Clone, Debug)]
pub struct UpdateSpentSetData {
    /// New Verkle root after update
    pub new_root: [u8; 64],

    /// Block range covered by this update
    pub block_range: (u64, u64),

    /// New key images to add to spent set
    pub new_key_images: Vec<[u8; 32]>,

    /// Proof of correct batch insertion
    pub proof: VerkleUpdateProof,
}