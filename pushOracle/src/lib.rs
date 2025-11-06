// Main library module for ZK-TLS Push Oracle
pub mod zk_tls;
pub mod tls_verifier;
pub mod solana_verifier;

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Re-export commonly used modules
pub use zk_tls::{ZkTlsProof, SessionProof, RpcProof};
pub use tls_verifier::{TlsVerifier, TlsConfig, TlsInfo};
pub use solana_verifier::{SolanaZkProof, SolanaConfig, SolanaSubmissionService};

/// Combined proof structure that includes both ZK-TLS and Solana components
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OracleProofBundle {
    pub zk_tls_proof: ZkTlsProof,
    pub solana_proof: SolanaZkProof,
    pub raw_data: MoneroRpcResponse,
    pub proof_version: String,
}

/// Monero RPC response structure
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MoneroRpcResponse {
    pub block_header: BlockHeaderData,
    pub transactions: Vec<TransactionData>,
    pub verification_hash: [u8; 32],
}

/// Clean block header data
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BlockHeaderData {
    pub version: u8,
    pub height: u64,
    pub timestamp: u64,
    pub hash: String,
    pub prev_hash: String,
    pub merkle_root: String,
    pub nonce: u32,
}

/// Clean transaction data
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TransactionData {
    pub tx_hash: String,
    pub amount: u64,
    pub fee: u64,
    pub ring_size: usize,
    pub inputs: Vec<String>,
    pub outputs: Vec<String>,
}

impl OracleProofBundle {
    /// Create a new oracle proof bundle from ZK-TLS proof
    pub fn new(
        zk_tls_proof: ZkTlsProof,
        solana_proof: SolanaZkProof,
        raw_data: MoneroRpcResponse,
    ) -> Self {
        Self {
            zk_tls_proof,
            solana_proof,
            raw_data,
            proof_version: "0.1.0".to_string(),
        }
    }

    /// Convert to bytes for network transmission
    pub fn to_bytes(&self) -> Vec<u8> {
        serde_json::to_vec(self).unwrap_or_default()
    }

    /// Convert from bytes
    pub fn from_bytes(bytes: &[u8]) -> Result<Self, String> {
        serde_json::from_slice(bytes).map_err(|e| e.to_string())
    }

    /// Verify the entire proof bundle
    pub fn verify(&self) -> bool {
        // Verify ZK-TLS proof validity
        if !self.zk_tls_proof.data_commitment.iter().any(|&x| x != 0) {
            return false;
        }

        // Verify Solana proof
        if !self.solana_proof.is_valid() {
            return false;
        }

        // Verify consistency between proofs
        if self.zk_tls_proof.data_commitment != self.solana_proof.data_commitment {
            return false;
        }

        true
    }
}

/// Configuration for the ZK-TLS Push Oracle
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OracleConfig {
    pub monero_nodes: Vec<String>,
    pub allowed_dns: Vec<String>,
    pub solana_program_id: String,
    pub solana_cluster: String,
    pub proof_interval: u64,
    pub keypair_path: Option<String>,
}

impl Default for OracleConfig {
    fn default() -> Self {
        Self {
            monero_nodes: vec![
                "https://moneroproxy.myxmr.com:38089".to_string(),
                "https://node.monerodevs.org:38089".to_string(),
            ],
            allowed_dns: vec![
                "moneroproxy.myxmr.com".to_string(),
                "node.monerodevs.org".to_string(),
            ],
            solana_program_id: "ZkMoneroOracle111111111111111111111111111".to_string(),
            solana_cluster: "devnet".to_string(),
            proof_interval: 30,
            keypair_path: None,
        }
    }
}

/// Network configuration for different environments
impl OracleConfig {
    pub fn devnet() -> Self {
        let mut config = Self::default();
        config.solana_cluster = "devnet".to_string();
        config.monero_nodes = vec![
            "https://testnet.moneroproxy.myxmr.com:38089".to_string(),
            "http://stagenet.melo.tools:38081".to_string(),
        ];
        config
    }

    pub fn mainnet() -> Self {
        let mut config = Self::default();
        config.solana_cluster = "mainnet".to_string();
        config.proof_interval = 60; // 1 minute for mainnet
        config
    }
}