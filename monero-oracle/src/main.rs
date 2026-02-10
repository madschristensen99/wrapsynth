//! Monero Oracle Service for zeroXMR on Unichain
//!
//! Fetches Monero blockchain data and posts it to the WrappedMonero contract.
//! Runs continuously to keep the contract synchronized with the Monero chain.
//!
//! # Usage
//! ```bash
//! cargo run --release
//! ```
//!
//! # Environment Variables
//! - `ORACLE_PRIVATE_KEY` - Private key of oracle account
//! - `BRIDGE_ADDRESS` - Address of WrappedMonero contract
//! - `UNICHAIN_RPC_URL` - Unichain RPC URL (default: https://mainnet.unichain.org)
//! - `MONERO_RPC_URL` - Monero RPC URL (default: http://xmr.privex.io:18081)
//! - `POLL_INTERVAL_SECS` - Polling interval in seconds (default: 120)

use alloy::{
    network::EthereumWallet,
    primitives::{Address, B256, U256},
    providers::{Provider, ProviderBuilder},
    signers::local::PrivateKeySigner,
    sol,
};
use anyhow::{Context, Result};
use chrono::Utc;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sha3::Keccak256;
use std::{env, time::Duration};
use tokio::time::interval;
use tracing::{error, info, warn};

// ════════════════════════════════════════════════════════════════════════════
// CONTRACT ABI
// ════════════════════════════════════════════════════════════════════════════

sol! {
    #[sol(rpc)]
    contract WrappedMonero {
        address public oracle;
        uint256 public latestMoneroBlock;

        function postMoneroBlock(
            uint256 blockHeight,
            bytes32 blockHash,
            bytes32 txMerkleRoot,
            bytes32 outputMerkleRoot
        ) external;

        function transferOracle(address newOracle) external;
    }
}

// ════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ════════════════════════════════════════════════════════════════════════════

#[derive(Debug, Clone)]
struct Config {
    oracle_private_key: String,
    bridge_address: Address,
    unichain_rpc_url: String,
    monero_rpc_url: String,
    poll_interval_secs: u64,
}

impl Config {
    fn from_env() -> Result<Self> {
        // Read bridge address from deployment file
        let deployment_path = "../deployments/unichain_testnet_latest.json";
        let bridge_address = if std::path::Path::new(deployment_path).exists() {
            let deployment_json = std::fs::read_to_string(deployment_path)
                .context("Failed to read deployment file")?;
            let deployment: serde_json::Value = serde_json::from_str(&deployment_json)
                .context("Failed to parse deployment JSON")?;
            let addr_str = deployment["contracts"]["WrappedMonero"]
                .as_str()
                .context("WrappedMonero address not found in deployment file")?;
            addr_str.parse().context("Invalid WrappedMonero address in deployment file")?
        } else {
            // Fallback to env var if deployment file doesn't exist
            env::var("BRIDGE_ADDRESS")
                .context("BRIDGE_ADDRESS not set and no deployment file found")?
                .parse()
                .context("Invalid BRIDGE_ADDRESS")?
        };

        Ok(Self {
            oracle_private_key: env::var("PRIVATE_KEY")
                .context("PRIVATE_KEY not set (used for both deployment and oracle)")?,
            bridge_address,
            unichain_rpc_url: env::var("UNICHAIN_RPC_URL")
                .unwrap_or_else(|_| "https://mainnet.unichain.org".to_string()),
            monero_rpc_url: env::var("MONERO_RPC_URL")
                .unwrap_or_else(|_| "http://xmr.privex.io:18081".to_string()),
            poll_interval_secs: env::var("POLL_INTERVAL_SECS")
                .unwrap_or_else(|_| "120".to_string())
                .parse()
                .unwrap_or(120),
        })
    }
}

// ════════════════════════════════════════════════════════════════════════════
// MONERO RPC TYPES
// ════════════════════════════════════════════════════════════════════════════

#[derive(Debug, Serialize)]
struct JsonRpcRequest<T> {
    jsonrpc: &'static str,
    id: &'static str,
    method: &'static str,
    params: T,
}

#[derive(Debug, Deserialize)]
struct JsonRpcResponse<T> {
    result: Option<T>,
    error: Option<JsonRpcError>,
}

#[derive(Debug, Deserialize)]
struct JsonRpcError {
    message: String,
}

#[derive(Debug, Deserialize)]
struct BlockHeaderResponse {
    block_header: BlockHeader,
}

#[derive(Debug, Deserialize)]
struct BlockHeader {
    height: u64,
    hash: String,
}

#[derive(Debug, Deserialize)]
struct GetBlockResponse {
    block_header: BlockHeader,
    json: String,
}

#[derive(Debug, Deserialize)]
struct BlockJson {
    tx_hashes: Option<Vec<String>>,
}

#[derive(Debug, Serialize)]
struct GetTransactionsRequest {
    txs_hashes: Vec<String>,
    decode_as_json: bool,
}

#[derive(Debug, Deserialize)]
struct GetTransactionsResponse {
    status: String,
    txs: Option<Vec<TransactionInfo>>,
}

#[derive(Debug, Deserialize)]
struct TransactionInfo {
    tx_hash: String,
    as_json: String,
}

#[derive(Debug, Deserialize)]
struct TransactionJson {
    vout: Option<Vec<TxOutput>>,
    rct_signatures: Option<RctSignatures>,
}

#[derive(Debug, Deserialize)]
struct TxOutput {
    target: Option<OutputTarget>,
}

#[derive(Debug, Deserialize)]
struct OutputTarget {
    key: Option<String>,
    tagged_key: Option<TaggedKey>,
}

#[derive(Debug, Deserialize)]
struct TaggedKey {
    key: String,
}

#[derive(Debug, Deserialize)]
struct RctSignatures {
    #[serde(rename = "ecdhInfo")]
    ecdh_info: Option<Vec<EcdhInfo>>,
    #[serde(rename = "outPk")]
    out_pk: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
struct EcdhInfo {
    amount: String,
}

// Extracted output data
#[derive(Debug, Clone)]
struct MoneroOutput {
    tx_hash: B256,
    output_index: u64,
    ecdh_amount: B256,
    output_pub_key: B256,
    commitment: B256,
}

// ════════════════════════════════════════════════════════════════════════════
// MONERO RPC CLIENT
// ════════════════════════════════════════════════════════════════════════════

struct MoneroRpcClient {
    client: Client,
    rpc_url: String,
}

impl MoneroRpcClient {
    fn new(rpc_url: String) -> Self {
        Self {
            client: Client::new(),
            rpc_url,
        }
    }

    async fn get_last_block_header(&self) -> Result<BlockHeader> {
        let request = JsonRpcRequest {
            jsonrpc: "2.0",
            id: "0",
            method: "get_last_block_header",
            params: serde_json::json!({}),
        };

        let response: JsonRpcResponse<BlockHeaderResponse> = self
            .client
            .post(format!("{}/json_rpc", self.rpc_url))
            .json(&request)
            .send()
            .await?
            .json()
            .await?;

        if let Some(error) = response.error {
            anyhow::bail!("Monero RPC error: {}", error.message);
        }

        Ok(response
            .result
            .context("No result in response")?
            .block_header)
    }

    async fn get_block(&self, height: u64) -> Result<GetBlockResponse> {
        let request = JsonRpcRequest {
            jsonrpc: "2.0",
            id: "0",
            method: "get_block",
            params: serde_json::json!({ "height": height }),
        };

        let response: JsonRpcResponse<GetBlockResponse> = self
            .client
            .post(format!("{}/json_rpc", self.rpc_url))
            .json(&request)
            .send()
            .await?
            .json()
            .await?;

        if let Some(error) = response.error {
            anyhow::bail!("Monero RPC error: {}", error.message);
        }

        response.result.context("No result in response")
    }

    async fn get_transactions(&self, tx_hashes: Vec<String>) -> Result<Vec<TransactionInfo>> {
        if tx_hashes.is_empty() {
            return Ok(vec![]);
        }

        let request = GetTransactionsRequest {
            txs_hashes: tx_hashes,
            decode_as_json: true,
        };

        let response: GetTransactionsResponse = self
            .client
            .post(format!("{}/get_transactions", self.rpc_url))
            .json(&request)
            .send()
            .await?
            .json()
            .await?;

        if response.status != "OK" {
            anyhow::bail!("Failed to get transactions: {}", response.status);
        }

        Ok(response.txs.unwrap_or_default())
    }

    async fn extract_outputs_from_block(&self, height: u64) -> Result<Vec<MoneroOutput>> {
        let block_data = self.get_block(height).await?;
        let block_json: BlockJson = serde_json::from_str(&block_data.json)?;

        let tx_hashes = block_json.tx_hashes.unwrap_or_default();
        if tx_hashes.is_empty() {
            info!("   No transactions in block {}", height);
            return Ok(vec![]);
        }

        info!(
            "   Fetching {} transaction(s) from block...",
            tx_hashes.len()
        );

        let transactions = self.get_transactions(tx_hashes).await?;
        let mut all_outputs = Vec::new();
        let mut global_output_index = 0u64; // Track global output index across all transactions

        for tx in transactions {
            let tx_json: TransactionJson = match serde_json::from_str(&tx.as_json) {
                Ok(j) => j,
                Err(e) => {
                    warn!("   Failed to parse transaction JSON: {}", e);
                    continue;
                }
            };

            let vout = match tx_json.vout {
                Some(v) => v,
                None => continue,
            };

            let rct_sigs = match tx_json.rct_signatures {
                Some(r) => r,
                None => continue,
            };

            let ecdh_info = rct_sigs.ecdh_info.unwrap_or_default();
            let out_pk = rct_sigs.out_pk.unwrap_or_default();

            for (i, output) in vout.iter().enumerate() {
                let output_pub_key = match &output.target {
                    Some(target) => {
                        if let Some(key) = &target.key {
                            key.clone()
                        } else if let Some(tagged_key) = &target.tagged_key {
                            tagged_key.key.clone()
                        } else {
                            continue;
                        }
                    }
                    None => continue,
                };

                let ecdh = match ecdh_info.get(i) {
                    Some(e) => &e.amount,
                    None => continue,
                };

                let commitment = match out_pk.get(i) {
                    Some(c) => c,
                    None => continue,
                };

                // Parse hex strings to B256
                let tx_hash = parse_hex_to_b256(&tx.tx_hash)?;
                let ecdh_amount = parse_hex_to_b256_padded(ecdh)?;
                let output_pub_key_bytes = parse_hex_to_b256(&output_pub_key)?;
                let commitment_bytes = parse_hex_to_b256(commitment)?;

                all_outputs.push(MoneroOutput {
                    tx_hash,
                    output_index: global_output_index, // Use global index, not local
                    ecdh_amount,
                    output_pub_key: output_pub_key_bytes,
                    commitment: commitment_bytes,
                });
                global_output_index += 1;
            }
        }

        info!(
            "   Extracted {} outputs from block {}",
            all_outputs.len(),
            height
        );
        Ok(all_outputs)
    }
}

// ════════════════════════════════════════════════════════════════════════════
// MERKLE TREE
// ════════════════════════════════════════════════════════════════════════════

fn compute_tx_merkle_root(tx_hashes: &[String]) -> B256 {
    if tx_hashes.is_empty() {
        return B256::ZERO;
    }

    if tx_hashes.len() == 1 {
        return parse_hex_to_b256(&tx_hashes[0]).unwrap_or(B256::ZERO);
    }

    // DEBUG: Log first and last TX
    if tx_hashes.len() > 0 {
        info!("   TX Merkle: {} transactions", tx_hashes.len());
        info!("   First TX: {}", &tx_hashes[0]);
        if tx_hashes.len() > 1 {
            info!("   Last TX: {}", &tx_hashes[tx_hashes.len() - 1]);
        }
    }

    let mut level: Vec<[u8; 32]> = tx_hashes
        .iter()
        .filter_map(|h| {
            let bytes = hex::decode(h).ok()?;
            if bytes.len() == 32 {
                let mut arr = [0u8; 32];
                arr.copy_from_slice(&bytes);
                Some(arr)
            } else {
                None
            }
        })
        .collect();

    while level.len() > 1 {
        let mut next_level = Vec::new();

        for chunk in level.chunks(2) {
            // Use alloy keccak256 to match contract verification
            use alloy::primitives::keccak256;
            
            let mut data = Vec::new();
            data.extend_from_slice(&chunk[0]);
            
            if chunk.len() > 1 {
                data.extend_from_slice(&chunk[1]);
            } else {
                // Duplicate last hash for odd number
                data.extend_from_slice(&chunk[0]);
            }

            let hash = keccak256(&data);
            next_level.push(hash.0);
        }

        level = next_level;
    }

    B256::from_slice(&level[0])
}

fn compute_output_merkle_root(outputs: &[MoneroOutput]) -> B256 {
    if outputs.is_empty() {
        return B256::ZERO;
    }

    // Create leaves: keccak256(abi.encodePacked(txHash, outputIndex, ecdhAmount, outputPubKey, commitment))
    let leaves: Vec<[u8; 32]> = outputs
        .iter()
        .map(|output| {
            use alloy::primitives::keccak256;

            // Pack the data similar to Solidity's abi.encodePacked
            let mut data = Vec::new();
            data.extend_from_slice(output.tx_hash.as_slice());
            data.extend_from_slice(&U256::from(output.output_index).to_be_bytes::<32>());
            data.extend_from_slice(output.ecdh_amount.as_slice());
            data.extend_from_slice(output.output_pub_key.as_slice());
            data.extend_from_slice(output.commitment.as_slice());

            keccak256(&data).0
        })
        .collect();

    if leaves.len() == 1 {
        return B256::from_slice(&leaves[0]);
    }

    let mut level = leaves;

    while level.len() > 1 {
        let mut next_level = Vec::new();

        for chunk in level.chunks(2) {
            let mut hasher = Sha256::new();
            hasher.update(&chunk[0]);

            if chunk.len() > 1 {
                hasher.update(&chunk[1]);
            } else {
                hasher.update(&chunk[0]);
            }

            let result = hasher.finalize();
            let mut arr = [0u8; 32];
            arr.copy_from_slice(&result);
            next_level.push(arr);
        }

        level = next_level;
    }

    B256::from_slice(&level[0])
}

// ════════════════════════════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════════════════════════════

fn parse_hex_to_b256(hex_str: &str) -> Result<B256> {
    let hex_str = hex_str.strip_prefix("0x").unwrap_or(hex_str);
    let bytes = hex::decode(hex_str)?;

    if bytes.len() != 32 {
        anyhow::bail!("Expected 32 bytes, got {}", bytes.len());
    }

    Ok(B256::from_slice(&bytes))
}

fn parse_hex_to_b256_padded(hex_str: &str) -> Result<B256> {
    let hex_str = hex_str.strip_prefix("0x").unwrap_or(hex_str);
    let bytes = hex::decode(hex_str)?;

    let mut padded = [0u8; 32];
    let start = 32 - bytes.len().min(32);
    padded[start..].copy_from_slice(&bytes[..bytes.len().min(32)]);

    Ok(B256::from_slice(&padded))
}

// ════════════════════════════════════════════════════════════════════════════
// ORACLE SERVICE
// ════════════════════════════════════════════════════════════════════════════

struct OracleService {
    config: Config,
    monero_client: MoneroRpcClient,
}

impl OracleService {
    fn new(config: Config) -> Self {
        let monero_client = MoneroRpcClient::new(config.monero_rpc_url.clone());
        Self {
            config,
            monero_client,
        }
    }

    async fn run(&self) -> Result<()> {
        info!("🔮 Monero Oracle Service Starting...\n");
        info!("Configuration:");
        info!("   Monero RPC: {}", self.config.monero_rpc_url);
        info!("   Unichain RPC: {}", self.config.unichain_rpc_url);
        info!("   WrappedMonero: {}", self.config.bridge_address);
        info!(
            "   Interval: {}s ({} min)",
            self.config.poll_interval_secs,
            self.config.poll_interval_secs / 60
        );

        // Set up wallet and provider
        let signer: PrivateKeySigner = self.config.oracle_private_key.parse()?;
        let wallet_address = signer.address();
        let wallet = EthereumWallet::from(signer);

        info!("\n👤 Oracle address: {}", wallet_address);

        let provider = ProviderBuilder::new()
            .with_recommended_fillers()
            .wallet(wallet)
            .on_builtin(&self.config.unichain_rpc_url)
            .await?;

        // Check balance
        let balance = provider.get_balance(wallet_address).await?;
        info!("   Balance: {} ETH", format_ether(balance));

        if balance.is_zero() {
            anyhow::bail!("Oracle has no ETH for gas! Please fund the oracle address.");
        }

        // Connect to contract
        let contract = WrappedMonero::new(self.config.bridge_address, &provider);

        // Verify oracle role
        let contract_oracle = contract.oracle().call().await?.oracle;
        if contract_oracle != wallet_address {
            anyhow::bail!(
                "Wallet is not the oracle!\n   Contract oracle: {}\n   Wallet address: {}",
                contract_oracle,
                wallet_address
            );
        }

        info!("\n✅ Oracle verified and ready!\n");
        info!("{}", "═".repeat(70));

        // Main polling loop
        let mut poll_interval = interval(Duration::from_secs(self.config.poll_interval_secs));

        loop {
            poll_interval.tick().await;

            if let Err(e) = self.poll(&contract).await {
                error!("❌ Error in oracle loop: {}", e);
            }
        }
    }

    async fn poll<T, P>(&self, contract: &WrappedMonero::WrappedMoneroInstance<T, P>) -> Result<()>
    where
        T: alloy::transports::Transport + Clone,
        P: Provider<T> + Clone,
    {
        info!(
            "\n[{}] 🔍 Checking Monero blockchain...",
            Utc::now().format("%Y-%m-%dT%H:%M:%SZ")
        );

        // Get latest Monero block header
        let header = self.monero_client.get_last_block_header().await?;
        let block_height = header.height;

        info!("   Latest Monero block: {}", block_height);
        info!("   Hash: 0x{}", header.hash);

        // Get last posted block from contract
        let latest_posted = contract.latestMoneroBlock().call().await?.latestMoneroBlock;
        let latest_posted_u64: u64 = latest_posted.try_into().unwrap_or(0);

        info!("   Last posted block: {}", latest_posted_u64);

        // Post all missing blocks
        if block_height > latest_posted_u64 {
            let blocks_to_post = block_height - latest_posted_u64;
            info!("   📊 {} new block(s) detected!", blocks_to_post);

            for height in (latest_posted_u64 + 1)..=block_height {
                info!("\n   📦 Processing block {}...", height);

                // Get full block with transactions
                let block_data = self.monero_client.get_block(height).await?;
                let block_json: BlockJson = serde_json::from_str(&block_data.json)?;
                let tx_hashes = block_json.tx_hashes.unwrap_or_default();
                let block_hash = parse_hex_to_b256(&block_data.block_header.hash)?;

                info!("      Transactions: {}", tx_hashes.len());

                // Compute TX Merkle root
                let tx_merkle_root = compute_tx_merkle_root(&tx_hashes);
                info!("      TX Merkle root: {}", tx_merkle_root);

                // Extract outputs from block
                let outputs = self.monero_client.extract_outputs_from_block(height).await?;
                info!("      Outputs: {}", outputs.len());

                // Compute output Merkle root
                let output_merkle_root = compute_output_merkle_root(&outputs);
                info!("      Output Merkle root: {}", output_merkle_root);

                // Post to contract
                self.post_block(contract, height, block_hash, tx_merkle_root, output_merkle_root)
                    .await?;
            }
        } else {
            info!("   ✅ Already up to date");
        }

        Ok(())
    }

    async fn post_block<T, P>(
        &self,
        contract: &WrappedMonero::WrappedMoneroInstance<T, P>,
        block_height: u64,
        block_hash: B256,
        tx_merkle_root: B256,
        output_merkle_root: B256,
    ) -> Result<()>
    where
        T: alloy::transports::Transport + Clone,
        P: Provider<T> + Clone,
    {
        info!("\n📤 Posting block {} to contract...", block_height);
        info!("   Hash: {}", block_hash);
        info!("   TX Merkle Root: {}", tx_merkle_root);
        info!("   Output Merkle Root: {}", output_merkle_root);

        // Try swapping blockHash and blockHeight to match struct order
        let tx = contract
            .postMoneroBlock(
                U256::from(block_height),
                block_hash,
                tx_merkle_root,
                output_merkle_root,
            )
            .send()
            .await;

        match tx {
            Ok(pending_tx) => {
                info!("   TX: {}", pending_tx.tx_hash());
                info!("   ⏳ Waiting for confirmation...");

                let receipt = pending_tx.get_receipt().await?;

                info!(
                    "   ✅ Confirmed in block {}",
                    receipt.block_number.unwrap_or(0)
                );
                info!("   Gas used: {}", receipt.gas_used);
            }
            Err(e) => {
                let error_str = e.to_string();
                if error_str.contains("Block already posted") || error_str.contains("Block exists")
                {
                    warn!("   ⚠️  Block {} already posted", block_height);
                } else {
                    return Err(e.into());
                }
            }
        }

        Ok(())
    }
}

fn format_ether(wei: U256) -> String {
    let wei_u128: u128 = wei.try_into().unwrap_or(u128::MAX);
    let ether = wei_u128 as f64 / 1e18;
    format!("{:.6}", ether)
}

// ════════════════════════════════════════════════════════════════════════════
// MAIN
// ════════════════════════════════════════════════════════════════════════════

#[tokio::main]
async fn main() -> Result<()> {
    // Initialize logging
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::from_default_env()
                .add_directive("monero_oracle=info".parse()?),
        )
        .init();

    // Load .env file from project root
    // Try parent directory first (when running from monero-oracle/)
    if let Err(_) = dotenvy::from_filename("../.env") {
        // Fall back to current directory
        dotenvy::dotenv().ok();
    }

    // Load configuration
    let config = Config::from_env()?;

    // Run oracle service
    let service = OracleService::new(config);
    service.run().await
}

// ════════════════════════════════════════════════════════════════════════════
// TESTS
// ════════════════════════════════════════════════════════════════════════════

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_compute_tx_merkle_root_empty() {
        let result = compute_tx_merkle_root(&[]);
        assert_eq!(result, B256::ZERO);
    }

    #[test]
    fn test_compute_tx_merkle_root_single() {
        let hashes = vec!["a".repeat(64)];
        let result = compute_tx_merkle_root(&hashes);
        assert_ne!(result, B256::ZERO);
    }

    #[test]
    fn test_compute_tx_merkle_root_multiple() {
        let hashes = vec!["a".repeat(64), "b".repeat(64), "c".repeat(64)];
        let result = compute_tx_merkle_root(&hashes);
        assert_ne!(result, B256::ZERO);
    }

    #[test]
    fn test_parse_hex_to_b256() {
        let hex = "a".repeat(64);
        let result = parse_hex_to_b256(&hex).unwrap();
        assert_eq!(result.as_slice(), &[0xaa; 32]);
    }

    #[test]
    fn test_parse_hex_to_b256_with_prefix() {
        let hex = format!("0x{}", "b".repeat(64));
        let result = parse_hex_to_b256(&hex).unwrap();
        assert_eq!(result.as_slice(), &[0xbb; 32]);
    }

    #[test]
    fn test_compute_output_merkle_root_empty() {
        let result = compute_output_merkle_root(&[]);
        assert_eq!(result, B256::ZERO);
    }
}
