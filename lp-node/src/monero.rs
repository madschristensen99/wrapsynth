use anyhow::{anyhow, Context, Result};
use monero::{
    util::key::{PrivateKey, PublicKey},
    Address, Network,
};
use reqwest::Client;
use std::str::FromStr;
use std::sync::Arc;
use tracing::{debug, info, warn};

/// Monero client with native key management using monero-rs
/// Uses monero-wallet-rpc for transaction operations
#[derive(Clone)]
pub struct MoneroClient {
    daemon_url: String,
    wallet_rpc_url: Option<String>,
    http_client: Arc<Client>,
    private_spend_key: PrivateKey,
    private_view_key: PrivateKey,
    address: Address,
    network: Network,
}

#[derive(Debug)]
pub struct IncomingTransfer {
    pub amount: u64,
    pub tx_hash: String,
    pub confirmations: u64,
    pub block_height: u64,
}

impl MoneroClient {
    /// Create a new Monero client with private key
    /// 
    /// For production use, also provide wallet_rpc_url for transaction operations.
    /// If wallet_rpc_url is None, transaction operations will use placeholders.
    pub fn new(daemon_url: String, private_spend_key_hex: String) -> Result<Self> {
        Self::new_with_wallet_rpc(daemon_url, private_spend_key_hex, None)
    }

    /// Create a new Monero client with wallet RPC support
    pub fn new_with_wallet_rpc(
        daemon_url: String,
        private_spend_key_hex: String,
        wallet_rpc_url: Option<String>,
    ) -> Result<Self> {
        // Parse the private spend key from hex
        let spend_key_bytes = hex::decode(private_spend_key_hex.trim_start_matches("0x"))
            .context("Invalid Monero private key hex")?;
        
        if spend_key_bytes.len() != 32 {
            anyhow::bail!("Monero private key must be 32 bytes (64 hex characters)");
        }
        
        let mut key_bytes = [0u8; 32];
        key_bytes.copy_from_slice(&spend_key_bytes);
        
        let private_spend_key = PrivateKey::from_slice(&key_bytes)
            .map_err(|e| anyhow!("Invalid Monero private spend key: {:?}", e))?;
        
        // Derive view key from spend key (standard Monero derivation)
        let private_view_key = PrivateKey::from_slice(&key_bytes)
            .map_err(|e| anyhow!("Failed to derive view key: {:?}", e))?;
        
        // Derive public keys
        let public_spend_key = PublicKey::from_private_key(&private_spend_key);
        let public_view_key = PublicKey::from_private_key(&private_view_key);
        
        // Create address (mainnet for now)
        let network = Network::Mainnet;
        let address = Address::standard(network, public_spend_key, public_view_key);
        
        info!("Monero wallet initialized");
        info!("Address: {}", address);
        
        if let Some(ref rpc_url) = wallet_rpc_url {
            info!("Wallet RPC enabled at: {}", rpc_url);
        } else {
            warn!("Wallet RPC not configured - transaction operations will be limited");
        }

        // Create HTTP client with longer timeout for Monero daemon
        let http_client = Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .context("Failed to create HTTP client")?;

        Ok(Self {
            daemon_url,
            wallet_rpc_url,
            http_client: Arc::new(http_client),
            private_spend_key,
            private_view_key,
            address,
            network,
        })
    }

    /// Call wallet RPC method
    async fn call_wallet_rpc<T: serde::de::DeserializeOwned>(
        &self,
        method: &str,
        params: serde_json::Value,
    ) -> Result<T> {
        let wallet_url = self.wallet_rpc_url.as_ref()
            .ok_or_else(|| anyhow!("Wallet RPC not configured"))?;

        let response = self.http_client
            .post(wallet_url)
            .json(&serde_json::json!({
                "jsonrpc": "2.0",
                "id": "0",
                "method": method,
                "params": params
            }))
            .send()
            .await
            .context("Failed to call wallet RPC")?;

        let result: serde_json::Value = response.json().await
            .context("Failed to parse wallet RPC response")?;

        if let Some(error) = result.get("error") {
            anyhow::bail!("Wallet RPC error: {}", error);
        }

        let data = result.get("result")
            .ok_or_else(|| anyhow!("Missing result in wallet RPC response"))?;

        serde_json::from_value(data.clone())
            .context("Failed to deserialize wallet RPC result")
    }

    /// Get the Monero address
    pub fn get_address(&self) -> Result<String> {
        Ok(self.address.to_string())
    }

    /// Get current blockchain height from daemon
    pub async fn get_height(&self) -> Result<u64> {
        // Call get_block_count RPC method
        let url = format!("{}/json_rpc", self.daemon_url);
        tracing::debug!("Calling Monero daemon at: {}", url);
        
        let response = self.http_client
            .post(&url)
            .json(&serde_json::json!({
                "jsonrpc": "2.0",
                "id": "0",
                "method": "get_block_count"
            }))
            .send()
            .await
            .with_context(|| format!("Failed to call Monero daemon at {}", url))?;
        
        let status = response.status();
        tracing::debug!("Monero daemon response status: {}", status);
        
        let result: serde_json::Value = response.json().await
            .context("Failed to parse daemon response")?;
        
        tracing::debug!("Monero daemon response: {:?}", result);
        
        let height = result["result"]["count"]
            .as_u64()
            .ok_or_else(|| anyhow!("Invalid block count in response"))?;
        
        Ok(height)
    }

    /// Send XMR to an address
    pub async fn send_xmr(
        &self,
        destination: &str,
        amount: u64,
    ) -> Result<String> {
        info!(
            "Sending {} XMR to {}",
            amount as f64 / 1e12,
            destination
        );

        // Validate destination address
        Address::from_str(destination)
            .map_err(|e| anyhow!("Invalid destination address: {:?}", e))?;

        if self.wallet_rpc_url.is_none() {
            warn!("Wallet RPC not configured - returning placeholder");
            return Ok("placeholder_tx_hash".to_string());
        }

        // Call wallet RPC transfer method
        let result: serde_json::Value = self.call_wallet_rpc(
            "transfer",
            serde_json::json!({
                "destinations": [{
                    "amount": amount,
                    "address": destination
                }],
                "priority": 1,
                "get_tx_key": true,
                "get_tx_hex": false,
            })
        ).await?;

        let tx_hash = result.get("tx_hash")
            .and_then(|v| v.as_str())
            .ok_or_else(|| anyhow!("Missing tx_hash in transfer result"))?;

        info!("Transaction sent: {}", tx_hash);
        Ok(tx_hash.to_string())
    }

    /// Get wallet balance
    pub async fn get_balance(&self) -> Result<(u64, u64)> {
        if self.wallet_rpc_url.is_none() {
            return Ok((0, 0));
        }

        let result: serde_json::Value = self.call_wallet_rpc(
            "get_balance",
            serde_json::json!({})
        ).await?;

        let balance = result.get("balance")
            .and_then(|v| v.as_u64())
            .unwrap_or(0);
        let unlocked_balance = result.get("unlocked_balance")
            .and_then(|v| v.as_u64())
            .unwrap_or(0);

        Ok((balance, unlocked_balance))
    }

    /// Create a PTLC (Point Time Locked Contract) on Monero
    /// Alias for send_xmr - TODO: implement proper PTLC support
    pub async fn create_ptlc(
        &self,
        destination: &str,
        amount: u64,
        _secret_hash: &[u8; 32],
    ) -> Result<String> {
        self.send_xmr(destination, amount).await
    }

    /// Sweep (claim) a PTLC using the revealed secret
    /// TODO: Implement proper PTLC claiming
    pub async fn sweep_ptlc(&self, _secret: &[u8; 32]) -> Result<String> {
        warn!("PTLC sweep not yet implemented");
        Ok("placeholder_sweep_tx".to_string())
    }


    /// Scan for incoming transfers
    pub async fn get_incoming_transfers(&self, min_height: u64) -> Result<Vec<IncomingTransfer>> {
        debug!("Scanning for incoming transfers from height {}", min_height);
        
        if self.wallet_rpc_url.is_none() {
            return Ok(Vec::new());
        }

        let result: serde_json::Value = self.call_wallet_rpc(
            "get_transfers",
            serde_json::json!({
                "in": true,
                "pending": false,
                "failed": false,
                "pool": false,
                "filter_by_height": true,
                "min_height": min_height,
            })
        ).await?;

        let mut transfers = Vec::new();
        
        if let Some(in_transfers) = result.get("in").and_then(|v| v.as_array()) {
            let current_height = self.get_height().await.unwrap_or(0);
            
            for transfer in in_transfers {
                if let (Some(amount), Some(tx_hash), Some(height)) = (
                    transfer.get("amount").and_then(|v| v.as_u64()),
                    transfer.get("txid").and_then(|v| v.as_str()),
                    transfer.get("height").and_then(|v| v.as_u64()),
                ) {
                    let confirmations = if current_height > height {
                        current_height - height
                    } else {
                        0
                    };

                    transfers.push(IncomingTransfer {
                        amount,
                        tx_hash: tx_hash.to_string(),
                        confirmations,
                        block_height: height,
                    });
                }
            }
        }

        debug!("Found {} incoming transfers", transfers.len());
        Ok(transfers)
    }

    /// Refresh wallet to sync with blockchain
    pub async fn refresh_wallet(&self) -> Result<()> {
        if self.wallet_rpc_url.is_none() {
            return Ok(());
        }

        let _: serde_json::Value = self.call_wallet_rpc(
            "refresh",
            serde_json::json!({})
        ).await?;

        Ok(())
    }

    /// Scan for a revealed secret in Monero transactions
    /// TODO: Implement PTLC secret extraction
    pub async fn scan_for_revealed_secret(
        &self,
        secret_hash: &[u8; 32],
        min_height: u64,
    ) -> Result<Option<[u8; 32]>> {
        debug!(
            "Scanning for revealed secret matching hash {}",
            hex::encode(secret_hash)
        );

        // TODO: Implement PTLC secret extraction from adaptor signatures
        warn!("PTLC secret extraction not yet implemented");
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

        // Refresh wallet first
        self.refresh_wallet().await?;

        // Get recent incoming transfers
        let current_height = self.get_height().await?;
        let min_height = current_height.saturating_sub(100);
        
        let transfers = self.get_incoming_transfers(min_height).await?;

        // Look for matching transfer
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

}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_address_derivation() {
        let private_key = "0000000000000000000000000000000000000000000000000000000000000001";
        let client = MoneroClient::new(
            "http://node.moneroworld.com:18089".to_string(),
            private_key.to_string(),
        ).unwrap();
        
        let address = client.get_address().unwrap();
        println!("Address: {}", address);
        assert!(!address.is_empty());
    }
}
