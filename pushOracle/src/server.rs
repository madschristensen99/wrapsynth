use std::net::{TcpListener, TcpStream};
use std::io::{BufRead, BufReader, Write};
use std::thread;
use std::sync::{Arc, Mutex};
use serde_json::Value;
use tokio::runtime::Runtime;

// Import our new ZK-TLS modules
mod zk_tls;
mod tls_verifier;
mod solana_verifier;
mod lib;

use crate::zk_tls::ZkTlsProof;
use crate::tls_verifier::TlsVerifier;
use crate::solana_verifier::{SolanaZkProof, SolanaConfig};
use crate::lib::{OracleProofBundle, MoneroRpcResponse, OracleConfig};

/// ZK-TLS enabled Monero Oracle Server
pub struct ZkTlsOracleServer {
    listener: TcpListener,
    proof_cache: Arc<Mutex<Option<OracleProofBundle>>>,
    config: OracleConfig,
    tls_verifier: TlsVerifier,
    runtime: Arc<Runtime>,
}

impl ZkTlsOracleServer {
    pub fn new(port: u16, config: OracleConfig) -> std::io::Result<Self> {
        let listener = TcpListener::bind(format!("0.0.0.0:{}", port))?;
        let tls_verifier = TlsVerifier::new(config.allowed_dns.clone());
        let runtime = Arc::new(Runtime::new().expect("Failed to create Tokio runtime"));

        Ok(Self {
            listener,
            proof_cache: Arc::new(Mutex::new(None)),
            config,
            tls_verifier,
            runtime,
        })
    }

    pub fn start(&mut self) {
        println!("🔐 ZK-TLS Monero Oracle starting on port {}", self.listener.local_addr().unwrap().port());
        println!("🌐 Solana cluster: {}", self.config.solana_cluster);
        println!("🔗 Monero nodes: {:?}", self.config.monero_nodes);
        println!("⏱️  Proof interval: {} seconds", self.config.proof_interval);
        
        // Start ZK proof generation service
        self.start_zk_prover();
        
        // Handle client connections
        for stream in self.listener.incoming() {
            match stream {
                Ok(stream) => {
                    let cache = Arc::clone(&self.proof_cache);
                    thread::spawn(move || {
                        if let Err(e) = Self::handle_client(stream, cache) {
                            eprintln!("❌ Client handler error: {}", e);
                        }
                    });
                }
                Err(e) => eprintln!("❌ Connection error: {}", e),
            }
        }
    }

    fn handle_client(
        mut stream: TcpStream,
        cache: Arc<Mutex<Option<OracleProofBundle>>>,
    ) -> std::io::Result<()> {
        let mut reader = BufReader::new(&stream);
        let mut buffer = String::new();
        reader.read_line(&mut buffer)?;
        
        let request = buffer.trim().to_uppercase();
        
        let response = match request.as_str() {
            "GET_ZK_PROOF" => {
                let cache = cache.lock().unwrap();
                if let Some(proof_bundle) = &*cache {
                    match serde_json::to_string(proof_bundle) {
                        Ok(json) => json,
                        Err(e) => format!("{{"error":"Failed to serialize proof: {}"}}", e)
                    }
                } else {
                    r#"{"error":"No proof available, oracle is still syncing"}"#.to_string()
                }
            },
            "GET_SOLANA_PROOF" => {
                let cache = cache.lock().unwrap();
                if let Some(proof_bundle) = &*cache {
                    match serde_json::to_string(&proof_bundle.solana_proof) {
                        Ok(json) => json,
                        Err(e) => format!("{{"error":"Failed to serialize Solana proof: {}"}}", e)
                    }
                } else {
                    r#"{"error":"No Solana proof available"}"#.to_string()
                }
            },
            "GET_LATEST_BLOCK" => {
                let cache = cache.lock().unwrap();
                if let Some(proof_bundle) = &*cache {
                    match serde_json::to_string(&proof_bundle.raw_data) {
                        Ok(json) => json,
                        Err(e) => format!("{{"error":"Failed to serialize block data: {}"}}", e)
                    }
                } else {
                    r#"{"error":"No block data available"}"#.to_string()
                }
            },
            "GET_ORACLE_STATUS" => {
                let cache = cache.lock().unwrap();
                let status = serde_json::json!({
                    "has_active_proof": cache.is_some(),
                    "proof_version": cache.as_ref().map(|p| &p.proof_version).unwrap_or(&"None".to_string()),
                    "proof_age_seconds": cache.as_ref().map(|p| {
                        std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .unwrap()
                            .as_secs()
                            .saturating_sub(p.zk_tls_proof.timestamp)
                    }).unwrap_or(0),
                    "network": "zk-tls-monero"
                });
                status.to_string()
            },
            "" => return Ok(()), // Client disconnected
            _ => {
                r#"{"error":"unknown command, use GET_ZK_PROOF, GET_SOLANA_PROOF, GET_LATEST_BLOCK, or GET_ORACLE_STATUS"}"#.to_string()
            }
        };
        
        stream.write_all(response.as_bytes())?;
        stream.write_all(b"\n")?;
        Ok(())
    }

    fn start_zk_prover(&self) {
        let cache = Arc::clone(&self.proof_cache);
        let config = self.config.clone();
        let tls_verifier = self.tls_verifier.clone();
        let runtime = Arc::clone(&self.runtime);
        
        thread::spawn(move || {
            let rt = runtime.clone();
            loop {
                rt.block_on(async {
                    match Self::generate_zk_proof(&config, &tls_verifier).await {
                        Ok(proof_bundle) => {
                            let mut cache = cache.lock().unwrap();
                            *cache = Some(proof_bundle);
                            println!("✅ Generated new ZK-TLS proof at {}", chrono::Utc::now().format("%H:%M:%S UTC"));
                        },
                        Err(e) => {
                            eprintln!("❌ Failed to generate ZK proof: {}", e);
                        }
                    }
                });
                
                thread::sleep(std::time::Duration::from_secs(config.proof_interval));
            }
        });
    }

    async fn generate_zk_proof(
        config: &OracleConfig,
        tls_verifier: &TlsVerifier,
    ) -> Result<OracleProofBundle, Box<dyn std::error::Error>> {
        // Select a random Monero node from the list
        use rand::seq::SliceRandom;
        let mut rng = rand::thread_rng();
        let node_url = config.monero_nodes.choose(&mut rng)
            .ok_or("No Monero nodes configured")?;

        // Generate TLS ZK proof for get_block_count
        let height_proof = tls_verifier.verify_monero_rpc_call(
            node_url,
            "get_block_count",
            &serde_json::json!({})
        ).await?;

        // Get actual height value
        let height_response = fetch_monero_height(node_url).await?;
        let block_height = height_response["result"]["count"]
            .as_u64()
            .unwrap_or(0)
            .saturating_sub(1); // Use previous block for confirmations

        // Generate TLS ZK proof for get_block
        let block_proof = tls_verifier.verify_monero_rpc_call(
            node_url,
            "get_block",
            &serde_json::json!({"height": block_height})
        ).await?;

        // Parse block data
        let raw_data = parse_monero_response(&block_proof).await?;

        // Create Solana-compatible proof
        let oracle_keypair = solana_sdk::signature::Keypair::new(); // In real deployment, load from keypair_path
        let solana_proof = SolanaZkProof::from_zk_proof(&block_proof, &oracle_keypair);

        // Create proof bundle
        let proof_bundle = OracleProofBundle::new(block_proof, solana_proof, raw_data);

        Ok(proof_bundle)
    }
}

/// Async helper functions
async fn fetch_monero_height(node_url: &str) -> Result<Value, Box<dyn std::error::Error>> {
    let client = reqwest::Client::new();
    
    let response = client
        .post(node_url)
        .json(&serde_json::json!({
            "jsonrpc": "2.0",
            "id": "0",
            "method": "get_block_count",
            "params": {}
        }))
        .send()
        .await?;

    Ok(response.json().await?)
}

async fn parse_monero_response(zk_proof: &ZkTlsProof) -> Result<MoneroRpcResponse, Box<dyn std::error::Error>> {
    // This would parse the actual decoded response
    // For now, create mock data structure
    Ok(MoneroRpcResponse {
        block_header: crate::lib::BlockHeaderData {
            version: 1,
            height: 100000, // Placeholder
            timestamp: zk_proof.timestamp,
            hash: "mock_hash".to_string(),
            prev_hash: "mock_prev_hash".to_string(),
            merkle_root: "mock_merkle_root".to_string(),
            nonce: 12345,
        },
        transactions: vec![], // Would parse actual transactions
        verification_hash: zk_proof.verification_hash(),
    })
}

// Add Clone for TlsVerifier
impl Clone for TlsVerifier {
    fn clone(&self) -> Self {
        Self {
            client: self.client.clone(),
            allowed_dns_names: self.allowed_dns_names.clone(),
        }
    }
}

fn main() {
    println!("🔐 Starting ZK-TLS Monero Oracle");
    
    let config = OracleConfig::devnet();
    let server = ZkTlsOracleServer::new(38089, config);
    
    match server {
        Ok(mut s) => {
            s.start();
        }
        Err(e) => {
            eprintln!("❌ Failed to start ZK-TLS Oracle: {}", e);
            std::process::exit(1);
        }
    }
}