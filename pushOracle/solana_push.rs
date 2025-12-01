use solana_sdk::{
    transaction::Transaction,
    instruction::{AccountMeta, Instruction},
    pubkey::Pubkey,
    signature::{Keypair, Signer},
    system_instruction,
    commitment_config::CommitmentConfig,
};
use solana_client::rpc_client::RpcClient;
use std::str::FromStr;
use tokio;

// Update Cargo.toml to include these dependencies
static PROGRAM_ID: &str = "MoneroOracleProgram111111111111111111111";

pub struct SolanaOracle {
    client: RpcClient,
    payer: Keypair,
    program_id: Pubkey,
}

impl SolanaOracle {
    pub fn new() -> Result<Self, Box<dyn std::error::Error>> {
        let client = RpcClient::new_with_commitment(
            "https://api.devnet.solana.com".to_string(),
            CommitmentConfig::confirmed(),
        );
        
        let payer = Keypair::new();
        let program_id = Pubkey::from_str(PROGRAM_ID)?;
        
        Ok(SolanaOracle {
            client,
            payer,
            program_id,
        })
    }
    
    pub async fn push_oracle_data(&self, block_hash: [u8; 32], height: u64, timestamp: u64, tx_count: u32, merkle_root: [u8; 32]) -> Result<String, Box<dyn std::error::Error>> {
        println!("Requesting devnet airdrop for {} ...", self.payer.pubkey());
        
        let _ = self.client.request_airdrop(&self.payer.pubkey(), 1_000_000_000).await;
        
        tokio::time::sleep(tokio::time::Duration::from_secs(3)).await;
        
        let mut instruction_data = Vec::new();
        instruction_data.extend_from_slice(&block_hash);
        instruction_data.extend_from_slice(&height.to_le_bytes());
        instruction_data.extend_from_slice(&timestamp.to_le_bytes());
        instruction_data.extend_from_slice(&tx_count.to_le_bytes());
        instruction_data.extend_from_slice(&merkle_root);
        
        let instruction = Instruction::new_with_bytes(
            self.program_id,
            &instruction_data,
            vec![
                AccountMeta::new(self.payer.pubkey(), true),
            ],
        );
        
        let recent_blockhash = self.client.get_latest_blockhash().await?;
        let transaction = Transaction::new_signed_with_payer(
            &[instruction],
            Some(&self.payer.pubkey()),
            &[&self.payer],
            recent_blockhash,
        );
        
        let signature = self.client.send_and_confirm_transaction(&transaction).await?;
        
        println!("✅ Oracle data pushed to Solana devnet!");
        println!("   Transaction: {}", signature);
        println!("   Block Height: {}", height);
        println!("   Block Hash: {}", hex::encode(block_hash));
        
        Ok(signature.to_string())
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let solana_oracle = SolanaOracle::new()?;
    
    // Fetch latest Monero data
    let monero_data = fetch_monero_data()?;
    
    // Push to Solana
    solana_oracle.push_oracle_data(
        monero_data.block_hash,
        monero_data.block_height,
        monero_data.timestamp,
        monero_data.tx_count,
        monero_data.merkle_root,
    ).await?;
    
    Ok(())
}

#[derive(Debug)]
struct MoneroData {
    block_hash: [u8; 32],
    block_height: u64,
    timestamp: u64,
    tx_count: u32,
    merkle_root: [u8; 32],
}

fn fetch_monero_data() -> Result<MoneroData, Box<dyn std::error::Error>> {
    use reqwest::blocking::Client;
    
    let client = Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()?;
    
    println!("🔄 Fetching Monero data...");
    
    let height_response: serde_json::Value = client
        .post("http://node.monerodevs.org:38089/json_rpc")
        .json(&serde_json::json!({
            "jsonrpc": "2.0",
            "id": "0",
            "method": "get_block_count",
            "params": {}
        }))
        .send()?
        .json()?;
        
    let height = height_response["result"]["count"].as_u64().unwrap_or(0).saturating_sub(1);
    
    let block_response: serde_json::Value = client
        .post("http://node.monerodevs.org:38089/json_rpc")
        .json(&serde_json::json!({
            "jsonrpc": "2.0",
            "id": "0",
            "method": "get_block",
            "params": {"height": height}
        }))
        .send()?
        .json()?;
    
    if let Some(result) = block_response["result"].as_object() {
        let block_header = &result["block_header"];
        
        let block_hash_str = block_header["hash"].as_str().unwrap();
        let mut block_hash = [0u8; 32];
        block_hash.copy_from_slice(&hex::decode(block_hash_str)?);
        
        let merkle_root_str = block_header["merkle_root"].as_str().unwrap();
        let mut merkle_root = [0u8; 32];
        merkle_root.copy_from_slice(&hex::decode(merkle_root_str)?);
        
        let tx_hashes = block_header.get("tx_hashes").and_then(|v| v.as_array()).unwrap_or_default();
        
        println!("✅ Monero data fetched:");
        println!("   Height: {} ", height);
        println!("   Hash: {}", block_hash_str);
        println!("   Tx count: {}", tx_hashes.len());
        println!("   Timestamp: {}", block_header["timestamp"].as_u64().unwrap_or(0));
        
        return Ok(MoneroData {
            block_hash,
            block_height: height,
            timestamp: block_header["timestamp"].as_u64().unwrap_or(0),
            tx_count: tx_hashes.len() as u32,
            merkle_root,
        });
    }
    
    Err("Invalid response structure".into())
}