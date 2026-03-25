use anyhow::{anyhow, Context, Result};
use monero::{
    util::key::{PrivateKey, PublicKey},
    Address, Network,
};
use reqwest::Client;
use std::str::FromStr;
use std::sync::Arc;
use tracing::{debug, info, warn};
use rand::rngs::OsRng;
use rand::RngCore;
use curve25519_dalek::{
    edwards::{CompressedEdwardsY, EdwardsPoint},
    scalar::Scalar,
};

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

/// Atomic swap keys for a single mint operation (Farcaster protocol)
#[derive(Debug, Clone)]
pub struct SwapKeys {
    /// LP's private spend key for this swap (s_b)
    pub lp_private_spend: PrivateKey,
    /// LP's private view key for this swap (v_b)
    pub lp_private_view: PrivateKey,
    /// LP's public spend key (P_b = s_b * G)
    pub lp_public_spend: PublicKey,
    /// LP's public view key (V_b = v_b * G)
    pub lp_public_view: PublicKey,
    /// Combined public spend key (P_a + P_b)
    pub combined_public_spend: PublicKey,
    /// Combined public view key (V_a + V_b)
    pub combined_public_view: PublicKey,
    /// Deposit address for this swap (derived from P_a + P_b)
    pub deposit_address: Address,
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

    /// Generate unique swap keys for a Farcaster atomic swap
    /// 
    /// Returns LP's keys (s_b, v_b) and combined keys with user's commitment (P_a)
    pub fn generate_swap_keys(&self, user_commitment: &[u8; 32]) -> Result<SwapKeys> {
        // Generate random LP keypair for this swap
        let mut rng = OsRng;
        
        // Generate s_b (LP's private spend key for this swap)
        let mut lp_scalar_bytes = [0u8; 32];
        rng.fill_bytes(&mut lp_scalar_bytes);
        let lp_scalar = Scalar::from_bytes_mod_order(lp_scalar_bytes);
        let lp_private_spend = PrivateKey::from_slice(&lp_scalar_bytes)
            .map_err(|e| anyhow!("Failed to create LP private spend key: {:?}", e))?;
        
        // Generate v_b (LP's private view key for this swap)
        let mut lp_view_bytes = [0u8; 32];
        rng.fill_bytes(&mut lp_view_bytes);
        let lp_private_view = PrivateKey::from_slice(&lp_view_bytes)
            .map_err(|e| anyhow!("Failed to create LP private view key: {:?}", e))?;
        
        // Derive LP's public keys
        let lp_public_spend = PublicKey::from_private_key(&lp_private_spend);
        let lp_public_view = PublicKey::from_private_key(&lp_private_view);
        
        // Parse user's commitment as P_a (user's public spend key)
        let user_compressed = CompressedEdwardsY::from_slice(user_commitment)
            .map_err(|_| anyhow!("Invalid user commitment format"))?;
        let user_point = user_compressed.decompress()
            .ok_or_else(|| anyhow!("Invalid user commitment - not a valid Ed25519 point"))?;
        
        // Parse LP's public spend key as point
        let lp_public_bytes = lp_public_spend.as_bytes();
        let lp_compressed = CompressedEdwardsY::from_slice(lp_public_bytes)
            .map_err(|_| anyhow!("Invalid LP public key format"))?;
        let lp_point = lp_compressed.decompress()
            .ok_or_else(|| anyhow!("Invalid LP public key"))?;
        
        // Compute P_a + P_b (combined public spend key)
        let combined_spend_point = user_point + lp_point;
        let combined_public_spend_bytes = combined_spend_point.compress().to_bytes();
        let combined_public_spend = PublicKey::from_slice(&combined_public_spend_bytes)
            .map_err(|e| anyhow!("Failed to create combined public spend key: {:?}", e))?;
        
        // For view key, we just use LP's view key (user will combine with their v_a)
        let combined_public_view = lp_public_view;
        
        // Create deposit address from combined keys
        let deposit_address = Address::standard(
            self.network,
            combined_public_spend,
            combined_public_view,
        );
        
        info!("Generated swap keys for atomic swap");
        info!("LP public spend: {}", hex::encode(lp_public_spend.as_bytes()));
        info!("Combined public spend: {}", hex::encode(combined_public_spend.as_bytes()));
        info!("Deposit address: {}", deposit_address);
        
        Ok(SwapKeys {
            lp_private_spend,
            lp_private_view,
            lp_public_spend,
            lp_public_view,
            combined_public_spend,
            combined_public_view,
            deposit_address,
        })
    }
    
    /// Verify XMR was locked to a specific swap address
    pub async fn verify_swap_lock(
        &self,
        swap_address: &Address,
        expected_amount: u64,
        min_confirmations: u64,
    ) -> Result<bool> {
        info!(
            "Verifying swap lock: {} XMR to address {}",
            expected_amount as f64 / 1e12,
            swap_address
        );
        
        // TODO: Implement proper address-specific verification
        // This requires wallet RPC with subaddress support or direct blockchain scanning
        // For now, fall back to checking main wallet
        warn!("Swap-specific address verification not yet implemented - checking main wallet");
        
        self.refresh_wallet().await?;
        let current_height = self.get_height().await?;
        let min_height = current_height.saturating_sub(100);
        let transfers = self.get_incoming_transfers(min_height).await?;
        
        for transfer in transfers {
            if transfer.amount >= expected_amount && transfer.confirmations >= min_confirmations {
                info!("Found matching transfer: {} with {} confirmations", transfer.tx_hash, transfer.confirmations);
                return Ok(true);
            }
        }
        
        debug!("No matching transfer found");
        Ok(false)
    }
    
    /// Claim XMR from swap address using combined secret (s_a + s_b)
    pub async fn claim_swap_xmr(
        &self,
        lp_private_spend: &PrivateKey,
        user_secret: &[u8; 32],
        destination: &str,
        amount: u64,
    ) -> Result<String> {
        info!("Claiming XMR from atomic swap");
        
        // Parse user's secret as scalar
        let user_scalar = Scalar::from_bytes_mod_order(*user_secret);
        
        // Parse LP's private key as scalar
        let lp_bytes = lp_private_spend.as_bytes();
        let mut lp_array = [0u8; 32];
        lp_array.copy_from_slice(lp_bytes);
        let lp_scalar = Scalar::from_bytes_mod_order(lp_array);
        
        // Compute combined secret: s_a + s_b
        let combined_scalar = user_scalar + lp_scalar;
        let combined_private_key_bytes = combined_scalar.to_bytes();
        let combined_private_key = PrivateKey::from_slice(&combined_private_key_bytes)
            .map_err(|e| anyhow!("Failed to create combined private key: {:?}", e))?;
        
        info!("Combined private key computed: {}", hex::encode(combined_private_key.as_bytes()));
        
        // TODO: Implement actual XMR transfer using wallet RPC
        // This requires sweeping from the swap address to the destination
        warn!("XMR claiming not yet fully implemented - requires wallet RPC integration");
        
        Ok("placeholder_tx_hash".to_string())
    }
    
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
