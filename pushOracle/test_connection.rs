use reqwest::blocking::Client;
use serde_json::Value;

fn main() {
    let client = Client::new();
    
    // Test different URL formats
    let urls = [
        "http://node.monerodevs.org:38089",
        "http://node.monerodevs.org:38089/json_rpc"
    ];
    
    for url in urls {
        println!("Testing URL: {}", url);
        match fetch_monero_data_test(url) {
            Ok(height) => {
                println!("✅ Successfully connected to {} - height: {}", url, height);
            }
            Err(e) => {
                println!("❌ Failed to connect to {}: {}", url, e);
            }
        }
    }
}

fn fetch_monero_data_test(node_url: &str) -> Result<u64, Box<dyn std::error::Error>> {
    let client = reqwest::blocking::Client::new();
    
    // Get current block height with timeout
    let height_response: Value = client
        .post(node_url)
        .timeout(std::time::Duration::from_secs(10))
        .json(&serde_json::json!({
            "jsonrpc": "2.0",
            "id": "0",
            "method": "get_block_count",
            "params": {}
        }))
        .send()?
        .json()?;
        
    let height = height_response["result"]["count"].as_u64().unwrap_or(0);
    Ok(height)
}