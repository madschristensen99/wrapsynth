use reqwest::blocking::Client;
use std::time::Duration;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    println!("🌟 Simple Monero Oracle Demo - Pushing to Solana Format");
    println!("==================================================");
    
    // Sample Monero endpoint (using the working format)
    let client = Client::builder()
        .timeout(Duration::from_secs(10))
        .build()?;
    
    println!("🔍 Fetching latest Monero block...");
    
    // Get block count
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
    
    // Get specific block data
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
    
    // Extract data for Solana format
    let block = &block_response["result"]["block_header"];
    let block_hash = block["hash"].as_str().unwrap();
    let merkle_root = block["merkle_root"].as_str().unwrap();
    let txs = block["tx_hashes"].as_array().unwrap_or(&vec![]);
    
    let solana_payload = format!(
        "SOLANA_PUSH {} {} {} {} {}",
        block_hash,
        block["height"].as_u64().unwrap(),
        block["timestamp"].as_u64().unwrap(),
        txs.len(),
        merkle_root
    );
    
    // Display formatted data for Solana
    println!("✅ Monero data successfully fetched!");
    println!("   📊 Height: {}", block["height"].as_u64().unwrap());
    println!("   📦 Hash: {}", block_hash);
    println!("   ⏰ Timestamp: {}", block["timestamp"].as_u64().unwrap());
    println!("   💸 Txs: {}", txs.len());
    println!("   🌳 Merkle: {}", merkle_root);
    
    println!("\n🔄 Solana Payload:");
    println!("{} bytes", solana_payload.len());
    println!("Payload: {}", solana_payload);
    
    // Create JSON for direct API call
    let solana_json = serde_json::json!({
        "instruction": "push_oracle_data",
        "data": {
            "block_hash": block_hash,
            "block_height": block["height"].as_u64().unwrap(),
            "timestamp": block["timestamp"].as_u64().unwrap(),
            "transaction_count": txs.len(),
            "merkle_root": merkle_root,
            "source": "monero_oracle",
            "timestamp_retrieved": std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_secs()
        }
    });
    
    println!("\n📋 JSON for Solana Program:");
    println!("{}", serde_json::to_string_pretty(&solana_json)?);
    
    Ok(())
}