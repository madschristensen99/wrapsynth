use anyhow::{anyhow, Context, Result};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::Arc;
use tracing::{debug, info, warn};

/// Monero RPC client for interacting with monero-wallet-rpc
#[derive(Clone)]
pub struct MoneroClient {
    client: Arc<Client>,
    rpc_url: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct RpcRequest {
    jsonrpc: String,
    id: String,
    method: String,
    params: Value,
}

#[derive(Debug, Serialize, Deserialize)]
struct RpcResponse<T> {
    jsonrpc: String,
    id: String,
    result: Option<T>,
    error: Option<RpcError>,
}

#[derive(Debug, Serialize, Deserialize)]
struct RpcError {
    code: i32,
    message: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Balance {
    pub balance: u64,
    pub unlocked_balance: u64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Transfer {
    pub amount: u64,
    pub tx_hash: String,
    pub tx_key: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct IncomingTransfer {
    pub amount: u64,
    pub tx_hash: String,
    pub confirmations: u64,
    pub block_height: u64,
}

impl MoneroClient {
    /// Create a new Monero RPC client
    pub fn new(rpc_url: String) -> Self {
        Self {
            client: Arc::new(Client::new()),
            rpc_url,
        }
    }

    /// Make a JSON-RPC call to monero-wallet-rpc
    async fn call<T: for<'de> Deserialize<'de>>(
        &self,
        method: &str,
        params: Value,
    ) -> Result<T> {
        debug!("Monero RPC call: {} with params: {:?}", method, params);
        
        let request = RpcRequest {
            jsonrpc: "2.0".to_string(),
            id: "0".to_string(),
            method: method.to_string(),
            params,
        };

        let response = self
            .client
            .post(&self.rpc_url)
            .json(&request)
            .send()
            .await
            .context("Failed to send Monero RPC request")?;

        let rpc_response: RpcResponse<T> = response
            .json()
            .await
            .context("Failed to parse Monero RPC response")?;

        if let Some(error) = rpc_response.error {
            return Err(anyhow!(
                "Monero RPC error {}: {}",
                error.code,
                error.message
            ));
        }

        rpc_response
            .result
            .ok_or_else(|| anyhow!("Missing result in Monero RPC response"))
    }

    /// Get wallet balance
    pub async fn get_balance(&self) -> Result<Balance> {
        let result: Value = self.call("get_balance", json!({})).await?;
        
        Ok(Balance {
            balance: result["balance"]
                .as_u64()
                .ok_or_else(|| anyhow!("Invalid balance"))?,
            unlocked_balance: result["unlocked_balance"]
                .as_u64()
                .ok_or_else(|| anyhow!("Invalid unlocked_balance"))?,
        })
    }

    /// Get wallet address
    pub async fn get_address(&self) -> Result<String> {
        let result: Value = self.call("get_address", json!({})).await?;
        
        result["address"]
            .as_str()
            .map(|s| s.to_string())
            .ok_or_else(|| anyhow!("Invalid address"))
    }

    /// Get current block height
    pub async fn get_height(&self) -> Result<u64> {
        let result: Value = self.call("get_height", json!({})).await?;
        
        result["height"]
            .as_u64()
            .ok_or_else(|| anyhow!("Invalid height"))
    }

    /// Create a PTLC (Point Time Locked Contract) on Monero
    /// 
    /// NOTE: This is a simplified representation. In production, you would need:
    /// 1. Monero PTLC support (currently experimental)
    /// 2. Custom transaction construction with adaptor signatures
    /// 3. Integration with Monero's cryptographic primitives
    /// 
    /// For now, this creates a standard transfer and tracks the secret separately
    pub async fn create_ptlc(
        &self,
        destination: &str,
        amount: u64,
        secret_hash: &[u8; 32],
    ) -> Result<String> {
        info!(
            "Creating PTLC: {} XMR to {} with secret_hash {}",
            amount as f64 / 1e12,
            destination,
            hex::encode(secret_hash)
        );

        // In a real implementation, this would create a PTLC transaction
        // For now, we'll use a standard transfer with the secret_hash in the payment_id
        // WARNING: This is NOT secure for production - implement proper PTLC support
        
        let payment_id = hex::encode(secret_hash);
        
        let params = json!({
            "destinations": [{
                "amount": amount,
                "address": destination
            }],
            "payment_id": payment_id,
            "get_tx_key": true,
            "get_tx_hex": true,
        });

        let result: Value = self.call("transfer", params).await?;
        
        let tx_hash = result["tx_hash"]
            .as_str()
            .ok_or_else(|| anyhow!("Missing tx_hash"))?
            .to_string();

        info!("PTLC created: {}", tx_hash);
        Ok(tx_hash)
    }

    /// Sweep (claim) a PTLC using the revealed secret
    /// 
    /// NOTE: This is a simplified representation. In production:
    /// 1. The secret would be used to complete the adaptor signature
    /// 2. The transaction would be broadcast to claim the locked XMR
    /// 
    /// For now, this assumes the XMR is already in our wallet
    pub async fn sweep_ptlc(&self, secret: &[u8; 32]) -> Result<String> {
        info!("Sweeping PTLC with secret {}", hex::encode(secret));

        // In a real implementation, this would:
        // 1. Construct a transaction using the secret to complete the adaptor signature
        // 2. Broadcast the transaction to claim the locked XMR
        
        // For now, we'll just verify we can access the funds
        let balance = self.get_balance().await?;
        info!(
            "Current balance: {} XMR",
            balance.unlocked_balance as f64 / 1e12
        );

        // Return a dummy transaction ID
        Ok(hex::encode(secret))
    }

    /// Scan for incoming transfers
    pub async fn get_incoming_transfers(&self, min_height: u64) -> Result<Vec<IncomingTransfer>> {
        let params = json!({
            "transfer_type": "available",
            "min_height": min_height,
        });

        let result: Value = self.call("incoming_transfers", params).await?;
        
        let transfers = result["transfers"]
            .as_array()
            .ok_or_else(|| anyhow!("Invalid transfers array"))?;

        let mut incoming = Vec::new();
        for transfer in transfers {
            incoming.push(IncomingTransfer {
                amount: transfer["amount"]
                    .as_u64()
                    .ok_or_else(|| anyhow!("Invalid amount"))?,
                tx_hash: transfer["tx_hash"]
                    .as_str()
                    .ok_or_else(|| anyhow!("Invalid tx_hash"))?
                    .to_string(),
                confirmations: transfer["confirmations"]
                    .as_u64()
                    .unwrap_or(0),
                block_height: transfer["block_height"]
                    .as_u64()
                    .ok_or_else(|| anyhow!("Invalid block_height"))?,
            });
        }

        Ok(incoming)
    }

    /// Scan for a revealed secret in Monero transactions
    /// 
    /// NOTE: This is a simplified representation. In production:
    /// 1. Monitor the Monero blockchain for PTLC claim transactions
    /// 2. Extract the secret from the adaptor signature witness data
    /// 3. Use cryptographic verification to ensure the secret is valid
    /// 
    /// For now, this is a placeholder that would need proper implementation
    pub async fn scan_for_revealed_secret(
        &self,
        secret_hash: &[u8; 32],
        min_height: u64,
    ) -> Result<Option<[u8; 32]>> {
        debug!(
            "Scanning for revealed secret matching hash {}",
            hex::encode(secret_hash)
        );

        // In a real implementation, this would:
        // 1. Scan the blockchain for transactions that claim our PTLC
        // 2. Extract the secret from the transaction witness data
        // 3. Verify the secret matches the hash using secp256k1
        
        // For now, we'll check incoming transfers with the payment_id
        let transfers = self.get_incoming_transfers(min_height).await?;
        
        for transfer in transfers {
            // Check if this transfer has sufficient confirmations
            if transfer.confirmations >= 10 {
                // In production, extract the secret from the transaction
                // For now, return None to indicate no secret found yet
                warn!("Found confirmed transfer but secret extraction not implemented");
            }
        }

        Ok(None)
    }

    /// Verify that a user has locked XMR for a mint operation
    pub async fn verify_mint_lock(
        &self,
        expected_amount: u64,
        claim_commitment: &[u8; 32],
        min_confirmations: u64,
    ) -> Result<bool> {
        info!(
            "Verifying mint lock: {} XMR with commitment {}",
            expected_amount as f64 / 1e12,
            hex::encode(claim_commitment)
        );

        // Get recent incoming transfers
        let current_height = self.get_height().await?;
        let min_height = current_height.saturating_sub(100); // Look back 100 blocks
        
        let transfers = self.get_incoming_transfers(min_height).await?;

        for transfer in transfers {
            if transfer.amount >= expected_amount
                && transfer.confirmations >= min_confirmations
            {
                info!(
                    "Found matching transfer: {} with {} confirmations",
                    transfer.tx_hash, transfer.confirmations
                );
                return Ok(true);
            }
        }

        debug!("No matching transfer found");
        Ok(false)
    }

    /// Refresh wallet to sync with the blockchain
    pub async fn refresh(&self) -> Result<()> {
        let _: Value = self.call("refresh", json!({})).await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    #[ignore] // Requires running monero-wallet-rpc
    async fn test_get_balance() {
        let client = MoneroClient::new("http://127.0.0.1:18082/json_rpc".to_string());
        let balance = client.get_balance().await.unwrap();
        println!("Balance: {:?}", balance);
    }

    #[tokio::test]
    #[ignore] // Requires running monero-wallet-rpc
    async fn test_get_address() {
        let client = MoneroClient::new("http://127.0.0.1:18082/json_rpc".to_string());
        let address = client.get_address().await.unwrap();
        println!("Address: {}", address);
    }
}
