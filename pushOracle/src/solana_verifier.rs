use solana_program::pubkey::Pubkey;
use solana_sdk::signature::{Keypair, Signer};
use solana_program::instruction::{AccountMeta, Instruction};
use crate::zk_tls::ZkTlsProof;
use borsh::{BorshSerialize, BorshDeserialize};

/// Solana-compatible ZK-TLS proof format
#[derive(Debug, Clone, BorshSerialize, BorshDeserialize)]
pub struct SolanaZkProof {
    /// Data commitment for on-chain verification
    pub data_commitment: [u8; 32],
    /// Verification hash for quick lookup
    pub verification_hash: [u8; 32],
    /// TLS session signature
    pub tls_signature: Vec<u8>,
    /// RPC response commitment
    pub rpc_commitment: [u8; 32],
    /// Block height (for time-based verification)
    pub block_height: u64,
    /// Timestamp for proof age validation
    pub timestamp: u64,
    /// Light-weight merkle proof (compressed)
    pub compressed_merkle: Vec<u8>,
    /// Public key of oracle operator
    pub oracle_pubkey: Pubkey,
}

impl SolanaZkProof {
    /// Convert ZK-TLS proof to Solana-compatible format
    pub fn from_zk_proof(zk_proof: &ZkTlsProof, oracle_keypair: &Keypair) -> Self {
        let verification_hash = zk_proof.verification_hash();
        let data_commitment = zk_proof.data_commitment;
        
        // Use oracle's public key
        let oracle_pubkey = oracle_keypair.pubkey();
        
        // Create compressed merkle proof (placeholder)
        let compressed_merkle = vec![0u8; 32]; // TODO: Implement compression

        // Extract block height from the proof
        let timestamp = zk_proof.timestamp;
        let block_height = Self::extract_block_height(zk_proof).unwrap_or(0);

        // Create digital signature for the proof
        let message = [
            &data_commitment[..],
            &verification_hash[..],
            &timestamp.to_le_bytes()[..],
            &block_height.to_le_bytes()[..],
        ].concat();
        
        let tls_signature = oracle_keypair.sign_message(&message).to_bytes().to_vec();

        Self {
            data_commitment,
            verification_hash,
            tls_signature,
            rpc_commitment: zk_proof.rpc_proof.response_commitment,
            block_height,
            timestamp,
            compressed_merkle,
            oracle_pubkey,
        }
    }

    /// Extract block height from ZK-TLS proof
    fn extract_block_height(zk_proof: &ZkTlsProof) -> Option<u64> {
        // This would parse block height from the proof data
        // For now, return 0 as placeholder
        Some(0)
    }

    /// Generate instruction for on-chain verification
    pub fn create_verification_instruction(
        &self,
        oracle_program: Pubkey,
        oracle_account: Pubkey,
        verifier_account: Pubkey,
    ) -> Instruction {
        let accounts = vec![
            AccountMeta::new(oracle_account, false),
            AccountMeta::new_readonly(verifier_account, true),
        ];

        // Create verification instruction data
        let instruction_data = VerificationInstructionData {
            proof: self.clone(),
        };

        Instruction {
            program_id: oracle_program,
            accounts,
            data: instruction_data.try_to_vec().unwrap(),
        }
    }

    /// Validate proof hasn't expired (assuming 5 minute validity)
    pub fn is_valid(&self) -> bool {
        let current_time = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        
        // 5 minute validity window
        const VALIDITY_WINDOW: u64 = 300;
        current_time.saturating_sub(self.timestamp) <= VALIDITY_WINDOW
    }
}

/// Verification instruction data for Solana program
#[derive(Debug, BorshSerialize, BorshDeserialize)]
pub struct VerificationInstructionData {
    pub proof: SolanaZkProof,
}

/// Oracle account structure for on-chain storage
#[derive(Debug, Clone, Default, BorshSerialize, BorshDeserialize)]
pub struct OracleAccount {
    /// Current verified block height
    pub verified_height: u64,
    /// Last verification timestamp
    pub last_verification: u64,
    /// Oracle operator public key
    pub operator: Pubkey,
    /// Verification count
    pub verification_count: u64,
    /// Slashed flag
    pub is_slashed: bool,
}

/// Configuration for Solana verification
pub struct SolanaConfig {
    pub program_id: Pubkey,
    pub cluster: String,
    pub confirmation_timeout: u64,
}

impl SolanaConfig {
    pub fn new(program_id: Pubkey, cluster: &str) -> Self {
        Self {
            program_id,
            cluster: cluster.to_string(),
            confirmation_timeout: 30,
        }
    }

    /// Create default configuration for devnet
    pub fn devnet() -> Self {
        Self {
            program_id: Pubkey::new_unique(), // Would be the actual program ID
            cluster: "devnet".to_string(),
            confirmation_timeout: 30,
        }
    }
}

/// Service to submit proofs to Solana
pub struct SolanaSubmissionService {
    pub config: SolanaConfig,
    pub rpc_client: solana_sdk::rpc_client::RpcClient,
}

impl SolanaSubmissionService {
    pub fn new(config: SolanaConfig) -> Self {
        let rpc_url = match config.cluster.as_str() {
            "devnet" => "https://api.devnet.solana.com".to_string(),
            "mainnet" => "https://api.mainnet-beta.solana.com".to_string(),
            "testnet" => "https://api.testnet.solana.com".to_string(),
            custom => custom.to_string(),
        };

        let rpc_client = solana_sdk::rpc_client::RpcClient::new(rpc_url);

        Self {
            config,
            rpc_client,
        }
    }

    /// Submit proof to Solana
    pub async fn submit_proof(&self, proof: &SolanaZkProof, payer: &Keypair) -> Result<String, Box<dyn std::error::Error>> {
        let instruction = proof.create_verification_instruction(
            self.config.program_id,
            self.config.program_id, // Oracle account
            payer.pubkey(),
        );

        let recent_blockhash = self.rpc_client.get_latest_blockhash()?;
        
        let transaction = solana_sdk::transaction::Transaction::new_signed_with_payer(
            &[instruction],
            Some(&payer.pubkey()),
            &[payer],
            recent_blockhash,
        );

        let signature = self.rpc_client.send_and_confirm_transaction(&transaction)?;
        Ok(signature.to_string())
    }

    /// Verify proof on-chain
    pub async fn verify_on_chain(&self, verification_hash: &[u8; 32]) -> Result<bool, Box<dyn std::error::Error>> {
        // This would call the on-chain verification program
        // For now, return mock result
        Ok(true)
    }
}