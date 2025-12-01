use std::net::{TcpListener, TcpStream};
use std::io::{BufRead, BufReader, Write};
use std::thread;
use std::sync::{Arc, Mutex};
use serde_json::Value;
use reqwest::blocking::Client;

mod xmrData;
use xmrData::{MoneroZkData, MoneroHeader, TransactionData, init_monero_oracle, get_monero_oracle_data};

pub struct OracleServer {
    listener: TcpListener,
    oracle_data: Arc<Mutex<MoneroZkData>>,
    node_url: String,
}

impl OracleServer {
    pub fn new(port: u16, node_url: String) -> std::io::Result<Self> {
        let listener = TcpListener::bind(format!("0.0.0.0:{}", port))?;
        init_monero_oracle();
        
        Ok(OracleServer {
            listener,
            oracle_data: Arc::new(Mutex::new(get_monero_oracle_data().clone())),
            node_url,
        })
    }

    pub fn start(&mut self) {
        println!("Trusted Monero oracle starting on port {}", self.listener.local_addr().unwrap().port());
        println!("Monero node endpoint: {}", self.node_url);
        
        // Start background thread to fetch from monero node
        self.start_node_fetcher();
        
        for stream in self.listener.incoming() {
            match stream {
                Ok(stream) => {
                    let data = Arc::clone(&self.oracle_data);
                    thread::spawn(move || {
                        if let Err(e) = Self::handle_client(stream, data) {
                            eprintln!("Client handler error: {}", e);
                        }
                    });
                }
                Err(e) => eprintln!("Connection error: {}", e),
            }
        }
    }

    fn handle_client(mut stream: TcpStream, data: Arc<Mutex<MoneroZkData>>) -> std::io::Result<()> {
        let mut reader = BufReader::new(&stream);
        let mut buffer = String::new();
        reader.read_line(&mut buffer)?;
        
        let request = buffer.trim();
        
        let response = match request {
            "GET_BLOCK_DATA" => {
                let data = data.lock().unwrap();
                serde_json::json!({
                    "block_header": {
                        "version": data.block_header.version,
                        "height": data.block_header.height,
                        "timestamp": data.block_header.timestamp,
                        "nonce": data.block_header.nonce,
                        "prev_id": hex::encode(data.block_header.prev_id),
                        "merkle_root": hex::encode(data.block_header.merkle_root)
                    },
                    "transactions": data.transactions.iter().map(|tx| {
                        serde_json::json!({
                            "tx_hash": hex::encode(&tx.tx_hash),
                            "pub_key": hex::encode(&tx.pub_key),
                            "amount": tx.amount,
                            "rct_type": tx.rct_type,
                            "key_images": tx.key_images.iter().map(|ki| hex::encode(ki)).collect::<Vec<_>>(),
                            "output_pk": tx.output_pk.iter().map(|pk| hex::encode(pk)).collect::<Vec<_>>(),
                            "commitments": tx.commitments.iter().map(|c| hex::encode(c)).collect::<Vec<_>>()
                        })
                    }).collect::<Vec<_>>(),
                    "merkle_proof": data.merkle_proof.iter().map(|mp| hex::encode(mp)).collect::<Vec<_>>(),
                    "batch_size": data.batch_size
                }).to_string()
            },
            "GET_ZK_BYTES" => {
                let data = data.lock().unwrap();
                let bytes = data.get_bytes_for_zk_proof();
                hex::encode(bytes)
            },
            "" => return Ok(()), // Client disconnected
            _ => {
                r#"{"error": "unknown command, use GET_BLOCK_DATA or GET_ZK_BYTES"}"#.to_string()
            }
        };
        
        stream.write_all(response.as_bytes())?;
        stream.write_all(b"\n")?;
        Ok(())
    }

    fn start_node_fetcher(&self) {
        let node_url = self.node_url.clone();
        let data = Arc::clone(&self.oracle_data);
        
        thread::spawn(move || {
            loop {
                match Self::fetch_monero_data(&node_url) {
                    Ok(new_data) => {
                        let mut oracle_data = data.lock().unwrap();
                        *oracle_data = new_data;
                        println!("Updated oracle with latest Monero data at height {}", oracle_data.block_header.height);
                    }
                    Err(e) => {
                        eprintln!("Failed to fetch Monero data: {}", e);
                    }
                }
                
                // Fetch every 30 seconds
                thread::sleep(std::time::Duration::from_secs(30));
            }
        });
    }

    fn fetch_monero_data(node_url: &str) -> Result<MoneroZkData, Box<dyn std::error::Error>> {
        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .build()?;
        
        // Get current block height
        let height_response: Value = client
            .post(node_url)
            .json(&serde_json::json!({
                "jsonrpc": "2.0",
                "id": "0",
                "method": "get_block_count",
                "params": {}
            }))
            .send()?
            .json()?;
            
        let height = height_response["result"]["count"].as_u64().unwrap_or(0).saturating_sub(1);
        println!("Got block height: {}", height);
        
        // Get block data
        let block_response: Value = client
            .post(node_url)
            .json(&serde_json::json!({
                "jsonrpc": "2.0",
                "id": "0",
                "method": "get_block",
                "params": {"height": height}
            }))
            .send()?
            .json()?;
        
        let mut zk_data = MoneroZkData::new();
        
        let block_header = MoneroHeader {
            version: block_response["result"]["block_header"]["version"].as_u64().unwrap_or(0) as u8,
            prev_id: hex::decode(
                block_response["result"]["block_header"]["prev_hash"].as_str().unwrap()
            ).unwrap().try_into().unwrap(),
            merkle_root: hex::decode(
                block_response["result"]["block_header"]["merkle_root"].as_str().unwrap()
            ).unwrap().try_into().unwrap(),
            timestamp: block_response["result"]["block_header"]["timestamp"].as_u64().unwrap_or(0),
            nonce: block_response["result"]["block_header"]["nonce"].as_u64().unwrap_or(0) as u32,
            height: height,
            depth: block_response["result"]["block_header"]["depth"].as_u64().unwrap_or(0),
        };
        
        zk_data.block_header = block_header;
        
        // Process transactions in the block
        let tx_hashes = block_response["result"]["block_header"]["tx_hashes"]
            .as_array()
            .unwrap_or(&vec![])
            .iter()
            .map(|tx| hex::decode(tx.as_str().unwrap()).unwrap().try_into().unwrap())
            .collect::<Vec<[u8; 32]>>();
            
        // For now, we'll use mock transaction data
        // In a real implementation, you'd fetch transaction details using get_transactions RPC
        for tx_hash in &tx_hashes {
            let tx = TransactionData {
                tx_hash: *tx_hash,
                pub_key: [0u8; 32], // Would be populated from actual tx data
                amount: 0,
                rct_type: 2, // RingCT v2
                key_images: vec![] as Vec<[u8; 32]>,
                output_pk: vec![] as Vec<[u8; 32]>,
                commitments: vec![] as Vec<[u8; 32]>,
            };
            zk_data.add_transaction(tx);
        }
        
        zk_data.calculate_merkle_proof(&tx_hashes);
        
        Ok(zk_data)
    }
}

fn main() {
    let server = OracleServer::new(38089, "http://node.monerodevs.org:38089".to_string());
    
    match server {
        Ok(mut s) => {
            s.start();
        }
        Err(e) => {
            eprintln!("Failed to start oracle server: {}", e);
        }
    }
}