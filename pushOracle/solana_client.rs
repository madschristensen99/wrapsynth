use solana_sdk::{
    signature::{Keypair, Signer},
    commitment_config::CommitmentConfig,
    rpc_client::RpcClient,
    transaction::Transaction,
    instruction::{Account, AccountMeta, Instruction},
    pubkey::Pubkey,
    system_instruction,
};
use solana_program::instruction::AccountMeta as ProgramAccountMeta;
use std::str::FromStr;

const PROGRAM_ID: &str = "MoneroOracleProgram111111111111111111111";

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("🚀 Monero Oracle Solana Integration");
    
    // Connect to Solana devnet
    let client = RpcClient::new_with_commitment(
        "https://api.devnet.solana.com".to_string(),
        CommitmentConfig::confirmed(),
    );
    
    let program_id = Pubkey::from_str(PROGRAM_ID)?;
    let payer = Keypair::new(); // Use devnet funding
    
    println!("Payer address: {}", payer.pubkey());
    
    // Get devnet SOL (for testing)
    match client.request_airdrop(&payer.pubkey(), 1_000_000_000).await {
        Ok(sig) => {
            println!("Airdrop requested: {}", sig);
            client.confirm_transaction(&sig).await?;
            println!("Airdrop confirmed");
        }
        Err(e) => {
            println!("Airdrop failed (may have existing devnet SOL): {}", e);
        }
    }
    
    // Fetch Monero data
    let monero_data = fetch_monero_oracle_data()?;
    
    // Push to Solana
    push_monero_data_to_solana(&client, &payer, &program_id, monero_data).await?;
    
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

async fn push_monero_data_to_solana(
    client: &RpcClient,
    payer: &Keypair,
    program_id: &Pubkey,
    data: MoneroData,
) -> Result<(), Box<dyn std::error::Error>> {
    
    println!("Preparing to push Monero data to Solana...");
    
    // Create instruction data
    let mut instruction_data = Vec::new();
    instruction_data.extend_from_slice(&data.block_hash);
    instruction_data.extend_from_slice(&data.block_height.to_le_bytes());
    instruction_data.extend_from_slice(&data.timestamp.to_le_bytes());
    instruction_data.extend_from_slice(&data.tx_count.to_le_bytes());
    instruction_data.extend_from_slice(&data.merkle_root);
    
    // Create the instruction
    let instruction = Instruction {
        program_id: *program_id,
        accounts: vec![
            AccountMeta::new(payer.pubkey(), true), // oracle account
        ],
        data: instruction_data,
    };
    
    // Create and send transaction
    let recent_blockhash = client.get_latest_blockhash().await?;
    let transaction = Transaction::new_signed_with_payer(
        &[instruction],
        Some(&payer.pubkey()),
        &[payer],
        recent_blockhash,
    );
    
    match client.send_and_confirm_transaction(&transaction).await {
        Ok(signature) => {
            println!("✅ Successfully pushed Monero data to Solana devnet!");
            println!("Transaction signature: {}", signature);
            
            // Show transaction details
            let confirmed_tx = client.get_transaction(&signature, UiTransactionEncoding::Json)
                .await?;
            println!("Transaction confirmed with status: {:?}", confirmed_tx.transaction.meta.unwrap().status);
        }
        Err(e) => {
            println!("❌ Failed to push data to Solana: {}", e);
        }
    }
    
    Ok(())
}

fn fetch_monero_oracle_data() -> Result<MoneroData, Box<dyn std::error::Error>> {
    use reqwest::blocking::Client;
    
    let client = Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()?;
    
    // Get current block height
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
    
    // Get block data
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
    
    let block_hash = hex::decode(block_response["result"]["block_header"]["hash"]
        .as_str().unwrap())
        .unwrap();
    let block_hash_array: [u8; 32] = block_hash.try_into().unwrap();
    
    let merkle_root = hex::decode(block_response["result"]["block_header"]["merkle_root"]
        .as_str().unwrap())
        .unwrap();
    let merkle_root_array: [u8; 32] = merkle_root.try_into().unwrap();
    
    Ok(MoneroData {
        block_hash: block_hash_array,
        block_height: height,
        timestamp: block_response["result"]["block_header"]["timestamp"].as_u64().unwrap(),
        tx_count: block_response["result"]["block_header"]["tx_hashes"].as_array()
            .unwrap().len() as u32,
        merkle_root: merkle_root_array,
    })
}

use solana_client::{
    rpc_config::RpcTransactionConfig,
    rpc_config::RpcSendTransactionConfig,
};
use solana_transaction_status::UiTransactionEncoding;