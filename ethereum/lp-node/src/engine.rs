use crate::db::{BurnStatus, BurnTask, Database, MintStatus, MintTask};
use crate::evm::EvmClient;
use crate::monero::MoneroClient;
use crate::oracle::OracleClient;
use alloy::primitives::FixedBytes;
use anyhow::{anyhow, Context, Result};
use k256::elliptic_curve::sec1::ToEncodedPoint;
use k256::SecretKey;
use rand::rngs::OsRng;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::time::{sleep, Duration};
use tracing::{debug, error, info, warn};

const MONERO_CONFIRMATIONS: u64 = 1;
const POLL_INTERVAL_SECS: u64 = 30;
const BURN_SAFETY_MARGIN_BLOCKS: u64 = 4320; // ~6 hours at 5s/block
const PRICE_POLL_INTERVAL_SECS: u64 = 30;
const PRICE_PUSH_THRESHOLD_BPS: u16 = 25;
const PRICE_PUSH_MAX_AGE_SECS: u64 = 90;

/// The main engine that orchestrates atomic swaps
pub struct SwapEngine {
    db: Database,
    evm: Arc<EvmClient>,
    monero: Arc<MoneroClient>,
    oracle: Arc<OracleClient>,
    enable_price_pusher: bool,
}

impl SwapEngine {
    pub fn new(db: Database, evm: Arc<EvmClient>, monero: Arc<MoneroClient>, enable_price_pusher: bool) -> Self {
        Self { 
            db, 
            evm, 
            monero,
            oracle: Arc::new(OracleClient::new()),
            enable_price_pusher,
        }
    }

    /// Start the engine - spawns all background workers
    pub async fn start(self: Arc<Self>) -> Result<()> {
        info!("Starting swap engine");

        // Spawn burn flow worker
        let engine = self.clone();
        tokio::spawn(async move {
            if let Err(e) = engine.burn_flow_worker().await {
                error!("Burn flow worker error: {}", e);
            }
        });

        // Spawn mint flow worker
        let engine = self.clone();
        tokio::spawn(async move {
            if let Err(e) = engine.mint_flow_worker().await {
                error!("Mint flow worker error: {}", e);
            }
        });

        // Spawn vault monitoring worker
        let engine = self.clone();
        tokio::spawn(async move {
            if let Err(e) = engine.vault_monitor_worker().await {
                error!("Vault monitor worker error: {}", e);
            }
        });

        // Spawn price pusher worker if enabled
        if self.enable_price_pusher {
            let engine = self.clone();
            tokio::spawn(async move {
                if let Err(e) = engine.price_pusher_worker().await {
                    error!("Price pusher worker error: {}", e);
                }
            });
            info!("Price pusher worker started");
        } else {
            info!("Price pusher disabled in config");
        }

        info!("All workers started");
        Ok(())
    }

    // ========== BURN FLOW ==========

    /// Worker that processes burn requests
    async fn burn_flow_worker(&self) -> Result<()> {
        info!("Burn flow worker started");

        loop {
            // Process all pending burns
            if let Err(e) = self.process_pending_burns().await {
                error!("Error processing pending burns: {}", e);
            }

            sleep(Duration::from_secs(POLL_INTERVAL_SECS)).await;
        }
    }

    async fn process_pending_burns(&self) -> Result<()> {
        // Get all non-completed burns
        let burns = self.db.get_all_burn_tasks()?;

        for mut burn in burns {
            match burn.status {
                BurnStatus::Requested => {
                    // Step 1: Generate secret and commit
                    if let Err(e) = self.handle_burn_requested(&mut burn).await {
                        error!("Error handling burn requested: {}", e);
                    }
                }
                BurnStatus::Committed => {
                    // Step 2: Create PTLC on Monero
                    if let Err(e) = self.handle_burn_committed(&mut burn).await {
                        error!("Error handling burn committed: {}", e);
                    }
                }
                BurnStatus::XmrLocked => {
                    // Step 3: Monitor for secret reveal
                    if let Err(e) = self.handle_burn_xmr_locked(&mut burn).await {
                        error!("Error handling burn XMR locked: {}", e);
                    }
                }
                BurnStatus::SecretRevealed => {
                    // Step 4: Finalize on EVM
                    if let Err(e) = self.handle_burn_secret_revealed(&mut burn).await {
                        error!("Error handling burn secret revealed: {}", e);
                    }
                }
                BurnStatus::Completed | BurnStatus::Slashed => {
                    // Nothing to do
                }
            }
        }

        Ok(())
    }

    async fn handle_burn_requested(&self, burn: &mut BurnTask) -> Result<()> {
        info!("Handling burn requested: {}", hex::encode(burn.request_id));

        // Generate a secure random secret
        let secret_key = SecretKey::random(&mut OsRng);
        let secret_bytes = secret_key.to_bytes();
        let mut secret = [0u8; 32];
        secret.copy_from_slice(&secret_bytes);

        // Compute the secp256k1 point (secret * G)
        let public_key = secret_key.public_key();
        let point = public_key.to_projective();
        
        // Encode the point as the secret hash
        let encoded = point.to_encoded_point(false);
        let point_bytes = encoded.as_bytes();
        let mut secret_hash = [0u8; 32];
        // Take the first 32 bytes of the uncompressed point (skip the 0x04 prefix)
        secret_hash.copy_from_slice(&point_bytes[1..33]);

        // CRITICAL: Persist the secret to the database BEFORE sending any transactions
        burn.secret = Some(secret);
        burn.secret_hash = Some(secret_hash);
        burn.status = BurnStatus::Committed;
        burn.updated_at = current_timestamp();
        self.db.update_burn_task(burn)?;

        info!("Secret persisted to database");

        // Now commit the burn on EVM
        let request_id = FixedBytes::from_slice(&burn.request_id);
        let secret_hash_fixed = FixedBytes::from_slice(&secret_hash);

        let tx_hash = self
            .evm
            .commit_burn(request_id, secret_hash_fixed)
            .await
            .context("Failed to commit burn on EVM")?;

        burn.commit_tx_hash = Some(tx_hash.0);
        self.db.update_burn_task(burn)?;

        info!("Burn committed on EVM: {}", hex::encode(tx_hash));
        Ok(())
    }

    async fn handle_burn_committed(&self, burn: &mut BurnTask) -> Result<()> {
        info!("Handling burn committed: {}", hex::encode(burn.request_id));

        // Get the user's Monero address (in production, this would be in the event data)
        // For now, we'll use a placeholder
        let user_monero_address = "PLACEHOLDER_MONERO_ADDRESS";

        let secret_hash = burn
            .secret_hash
            .ok_or_else(|| anyhow::anyhow!("Missing secret hash"))?;

        // Create PTLC on Monero
        let tx_hash = self
            .monero
            .create_ptlc(user_monero_address, burn.xmr_amount, &secret_hash)
            .await
            .context("Failed to create PTLC on Monero")?;

        burn.monero_lock_txid = Some(tx_hash);
        burn.status = BurnStatus::XmrLocked;
        burn.updated_at = current_timestamp();
        self.db.update_burn_task(burn)?;

        info!("XMR locked on Monero: {}", burn.monero_lock_txid.as_ref().unwrap());
        Ok(())
    }

    async fn handle_burn_xmr_locked(&self, burn: &mut BurnTask) -> Result<()> {
        debug!("Monitoring burn for secret reveal: {}", hex::encode(burn.request_id));

        let secret_hash = burn
            .secret_hash
            .ok_or_else(|| anyhow::anyhow!("Missing secret hash"))?;

        // Scan Monero blockchain for the revealed secret
        let current_height = self.monero.get_height().await?;
        let min_height = current_height.saturating_sub(100);

        if let Some(revealed_secret) = self
            .monero
            .scan_for_revealed_secret(&secret_hash, min_height)
            .await?
        {
            info!("Secret revealed by user: {}", hex::encode(revealed_secret));

            // Verify it matches our secret (sanity check)
            let our_secret = burn.secret.ok_or_else(|| anyhow::anyhow!("Missing secret"))?;
            if revealed_secret != our_secret {
                warn!("Revealed secret does not match our secret!");
                return Ok(());
            }

            burn.status = BurnStatus::SecretRevealed;
            burn.updated_at = current_timestamp();
            self.db.update_burn_task(burn)?;
        } else {
            // Check if we're approaching the deadline
            let current_block = self.evm.get_block_number().await.unwrap_or(0);
            let safety_deadline = burn.deadline.saturating_sub(BURN_SAFETY_MARGIN_BLOCKS);

            if current_block >= safety_deadline {
                warn!(
                    "Approaching deadline for burn {}, but user hasn't revealed secret yet",
                    hex::encode(burn.request_id)
                );
            }
        }

        Ok(())
    }

    async fn handle_burn_secret_revealed(&self, burn: &mut BurnTask) -> Result<()> {
        info!("Finalizing burn on EVM: {}", hex::encode(burn.request_id));

        let secret = burn.secret.ok_or_else(|| anyhow::anyhow!("Missing secret"))?;
        let request_id = FixedBytes::from_slice(&burn.request_id);
        let secret_fixed = FixedBytes::from_slice(&secret);

        let tx_hash = self
            .evm
            .finalize_burn(request_id, secret_fixed)
            .await
            .context("Failed to finalize burn on EVM")?;

        burn.status = BurnStatus::Completed;
        burn.updated_at = current_timestamp();
        self.db.update_burn_task(burn)?;

        info!("Burn finalized on EVM: {}", hex::encode(tx_hash));
        Ok(())
    }

    // ========== MINT FLOW ==========

    /// Worker that processes mint requests
    async fn mint_flow_worker(&self) -> Result<()> {
        info!("Mint flow worker started");

        loop {
            // Process all pending mints
            if let Err(e) = self.process_pending_mints().await {
                error!("Error processing pending mints: {}", e);
            }

            sleep(Duration::from_secs(POLL_INTERVAL_SECS)).await;
        }
    }

    async fn process_pending_mints(&self) -> Result<()> {
        // Get all non-completed mints
        let mints = self.db.get_all_mint_tasks()?;
        let current_block = self.evm.get_block_number().await.unwrap_or(0);

        for mut mint in mints {
            // Check if mint has expired
            if mint.timeout > 0 && current_block >= mint.timeout && 
               !matches!(mint.status, MintStatus::Completed | MintStatus::Cancelled) {
                warn!("Mint {} has expired (timeout: {}, current: {})", 
                    hex::encode(mint.request_id), mint.timeout, current_block);
                if let Err(e) = self.handle_mint_expired(&mut mint).await {
                    error!("Error handling expired mint: {}", e);
                }
                continue;
            }

            match mint.status {
                MintStatus::Pending => {
                    // Step 1: Verify user locked XMR
                    if let Err(e) = self.handle_mint_pending(&mut mint).await {
                        error!("Error handling mint pending: {}", e);
                    }
                }
                MintStatus::XmrLocked => {
                    // Step 2: Wait for confirmations and set ready
                    if let Err(e) = self.handle_mint_xmr_locked(&mut mint).await {
                        error!("Error handling mint XMR locked: {}", e);
                    }
                }
                MintStatus::Ready => {
                    // Step 3: Claim XMR and finalize
                    if let Err(e) = self.handle_mint_ready(&mut mint).await {
                        error!("Error handling mint ready: {}", e);
                    }
                }
                MintStatus::XmrClaimed => {
                    // Step 4: Finalize on EVM
                    if let Err(e) = self.handle_mint_xmr_claimed(&mut mint).await {
                        error!("Error handling mint XMR claimed: {}", e);
                    }
                }
                MintStatus::Completed | MintStatus::Cancelled => {
                    // Nothing to do
                }
            }
        }

        Ok(())
    }

    async fn handle_mint_expired(&self, mint: &mut MintTask) -> Result<()> {
        info!("Handling expired mint: {}", hex::encode(mint.request_id));

        // Call cancelMint on the contract
        let request_id = FixedBytes::from_slice(&mint.request_id);
        match self.evm.cancel_mint(request_id).await {
            Ok(tx_hash) => {
                info!("Cancelled mint on EVM: {:?}", tx_hash);
            }
            Err(e) => {
                warn!("Failed to cancel mint on EVM (may already be cancelled): {}", e);
            }
        }

        // Sweep XMR from deposit address back to LP wallet
        if let (Some(deposit_address), Some(lp_private_spend), Some(lp_private_view)) = (
            &mint.deposit_address,
            &mint.lp_private_spend,
            &mint.lp_private_view,
        ) {
            info!("Attempting to sweep XMR from deposit address: {}", deposit_address);
            match self.monero.sweep_from_swap_address(
                deposit_address,
                lp_private_spend,
                lp_private_view,
            ).await {
                Ok(tx_hash) => {
                    if tx_hash == "no_funds" {
                        info!("No XMR to sweep from deposit address (user never sent funds)");
                    } else {
                        info!("Successfully swept XMR in transaction: {}", tx_hash);
                        mint.monero_claim_txid = Some(tx_hash);
                    }
                }
                Err(e) => {
                    warn!("Failed to sweep XMR from deposit address: {}", e);
                    warn!("Funds may remain at address: {}", deposit_address);
                }
            }
        } else {
            warn!("Missing swap keys or deposit address - cannot sweep XMR");
        }

        // Update status
        mint.status = MintStatus::Cancelled;
        mint.updated_at = current_timestamp();
        self.db.update_mint_task(mint)?;

        Ok(())
    }

    async fn handle_mint_pending(&self, mint: &mut MintTask) -> Result<()> {
        info!("Checking for XMR lock: {}", hex::encode(mint.request_id));

        // Verify the user has locked XMR on Monero
        let verified = self
            .monero
            .verify_mint_lock(
                mint.xmr_amount,
                &mint.claim_commitment,
                mint.deposit_address.as_deref(),
                &mint.lp_private_view,
                1
            )
            .await?;

        if verified {
            info!("XMR lock verified for mint {}", hex::encode(mint.request_id));
            mint.status = MintStatus::XmrLocked;
            mint.updated_at = current_timestamp();
            self.db.update_mint_task(mint)?;
        }

        Ok(())
    }

    async fn handle_mint_xmr_locked(&self, mint: &mut MintTask) -> Result<()> {
        info!("Waiting for confirmations: {}", hex::encode(mint.request_id));

        // Verify sufficient confirmations
        let verified = self
            .monero
            .verify_mint_lock(
                mint.xmr_amount,
                &mint.claim_commitment,
                mint.deposit_address.as_deref(),
                &mint.lp_private_view,
                MONERO_CONFIRMATIONS
            )
            .await?;

        if verified {
            info!(
                "XMR lock confirmed for mint {}",
                hex::encode(mint.request_id)
            );

            // Check on-chain status first to avoid calling setMintReady if already called
            let request_id = FixedBytes::from_slice(&mint.request_id);
            info!("Checking on-chain status before calling setMintReady...");
            
            // Try to get on-chain status, but if it fails, assume PENDING and try to provide LP key
            let should_provide_key = match self.evm.get_mint_status(request_id).await {
                Ok(status) => {
                    info!("On-chain mint status: {}", status);
                    
                    // Status 4 = COMPLETED, Status 5 = CANCELLED
                    if status >= 4 {
                        info!("Mint already finalized on-chain (status: {}), marking as completed", status);
                        mint.status = if status == 4 { MintStatus::Completed } else { MintStatus::Cancelled };
                        mint.updated_at = current_timestamp();
                        self.db.update_mint_task(mint)?;
                        return Ok(());
                    }
                    
                    if status == 3 { // READY
                        info!("Mint already ready on-chain (status: {}), updating local state", status);
                        mint.status = MintStatus::Ready;
                        mint.updated_at = current_timestamp();
                        self.db.update_mint_task(mint)?;
                        return Ok(());
                    }
                    
                    status == 0 // PENDING - need to provide LP key
                }
                Err(e) => {
                    warn!("Failed to check on-chain status: {}, assuming PENDING and will try to provide LP key", e);
                    true // Assume PENDING if we can't check
                }
            };
            
            // Provide LP key if needed
            if should_provide_key {
                info!("Providing LP key before setMintReady...");
                
                if let Some(lp_public_spend_bytes) = mint.lp_public_spend {
                    match self.evm.provide_lp_key(request_id, lp_public_spend_bytes.into()).await {
                        Ok(tx_hash) => {
                            info!("LP key provided on-chain: {:?}", tx_hash);
                        }
                        Err(e) => {
                            // If provideLPKey fails, it might already be provided - continue anyway
                            warn!("Failed to provide LP key (may already be provided): {}", e);
                        }
                    }
                } else {
                    warn!("LP public key not found in mint task, skipping provideLPKey");
                }
            }

            // Update oracle prices using Node.js script (RedStone SDK only works in JS)
            info!("Updating oracle prices via RedStone...");
            match self.update_redstone_prices().await {
                Ok(tx_hash) => {
                    info!("Oracle prices updated: {}", tx_hash);
                }
                Err(e) => {
                    warn!("Failed to update oracle prices: {}", e);
                    // Continue anyway - setMintReady will fail with StalePrice if needed
                }
            }

            // Call setMintReady on EVM
            let tx_hash = self
                .evm
                .set_mint_ready(request_id)
                .await
                .context("Failed to set mint ready on EVM")?;

            mint.status = MintStatus::Ready;
            mint.updated_at = current_timestamp();
            self.db.update_mint_task(mint)?;

            info!("Mint ready set on EVM: {}", hex::encode(tx_hash));
        }

        Ok(())
    }

    async fn update_redstone_prices(&self) -> Result<String> {
        use tokio::process::Command;
        
        let output = Command::new("node")
            .arg("update-prices.js")
            .current_dir(std::env::current_dir()?)
            .output()
            .await
            .context("Failed to execute Node.js price updater")?;
        
        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            anyhow::bail!("Price update script failed: {}", stderr);
        }
        
        let tx_hash = String::from_utf8(output.stdout)
            .context("Invalid UTF-8 in script output")?
            .trim()
            .to_string();
        
        Ok(tx_hash)
    }

    async fn handle_mint_ready(&self, mint: &mut MintTask) -> Result<()> {
        info!("Mint ready - waiting for user to finalize: {}", hex::encode(mint.request_id));

        // LP has called setMintReady() - now wait for user to call finalizeMint()
        // The user will reveal their secret when they finalize
        // We'll watch for the MintFinalized event to extract the secret and claim XMR
        
        // Nothing to do here - just wait for user finalization
        // The status stays as Ready until we see MintFinalized event
        
        Ok(())
    }

    async fn handle_mint_xmr_claimed(&self, mint: &mut MintTask) -> Result<()> {
        info!("Finalizing mint on EVM: {}", hex::encode(mint.request_id));

        let secret = mint
            .revealed_secret
            .ok_or_else(|| anyhow::anyhow!("Missing revealed secret"))?;
        let request_id = FixedBytes::from_slice(&mint.request_id);
        let secret_fixed = FixedBytes::from_slice(&secret);

        let tx_hash = self
            .evm
            .finalize_mint(request_id, secret_fixed)
            .await
            .context("Failed to finalize mint on EVM")?;

        mint.status = MintStatus::Completed;
        mint.updated_at = current_timestamp();
        self.db.update_mint_task(mint)?;

        info!("Mint finalized on EVM: {}", hex::encode(tx_hash));
        Ok(())
    }

    // ========== VAULT MONITORING ==========

    /// Worker that monitors vault health and manages collateral
    async fn vault_monitor_worker(&self) -> Result<()> {
        info!("Vault monitor worker started");

        loop {
            if let Err(e) = self.check_vault_health().await {
                error!("Error checking vault health: {}", e);
            }

            sleep(Duration::from_secs(300)).await; // Check every 5 minutes
        }
    }

    async fn check_vault_health(&self) -> Result<()> {
        let vault = self.evm.get_vault().await?;

        if !vault.active {
            warn!("Vault is not active!");
            return Ok(());
        }

        // In production, fetch real prices from Pyth or another oracle
        let xmr_price_usd = 150.0; // PLACEHOLDER
        let collateral_price_usd = 2000.0; // PLACEHOLDER

        let ratio = vault.collateralization_ratio(xmr_price_usd, collateral_price_usd);

        info!(
            "Vault health - Collateral: {}, Normalized Debt: {}, Ratio: {:.2}%",
            vault.collateral_shares, vault.normalized_debt, ratio
        );

        if ratio < 150.0 {
            warn!("Vault collateralization ratio below target: {:.2}%", ratio);
            // In production, implement automatic collateral top-up or debt reduction
        }

        if ratio < 120.0 {
            error!("CRITICAL: Vault is liquidatable! Ratio: {:.2}%", ratio);
            // In production, implement emergency procedures
        }

        Ok(())
    }

    // ========== PRICE PUSHER ==========

    /// Worker that pushes oracle prices from RedStone API
    async fn price_pusher_worker(&self) -> Result<()> {
        info!("Price pusher worker started");

        loop {
            if let Err(e) = self.push_prices_if_needed().await {
                error!("Error pushing prices: {}", e);
            }

            sleep(Duration::from_secs(PRICE_POLL_INTERVAL_SECS)).await;
        }
    }

    async fn push_prices_if_needed(&self) -> Result<()> {
        let prices = self.oracle.fetch_redstone_prices().await?;

        let (last_xmr_price, last_timestamp) = match self.evm.get_last_oracle_state().await {
            Ok(state) => state,
            Err(e) => {
                warn!("Failed to get last oracle state: {}", e);
                return Ok(());
            }
        };

        let now = current_timestamp();
        let age = now.saturating_sub(last_timestamp);
        let drift_bps = OracleClient::calculate_drift_bps(last_xmr_price, prices.xmr_price);

        if drift_bps > PRICE_PUSH_THRESHOLD_BPS || age > PRICE_PUSH_MAX_AGE_SECS {
            info!(
                "Pushing oracle update: drift={}bps age={}s",
                drift_bps, age
            );

            match self.oracle.fetch_redstone_data_packages().await {
                Ok(redstone_data) => {
                    match self.evm.update_oracle_prices_redstone(redstone_data).await {
                        Ok(tx_hash) => {
                            info!(
                                "Oracle updated: xmr={} dai={} drift={}bps age={}s tx={:?}",
                                prices.xmr_price, prices.dai_price, drift_bps, age, tx_hash
                            );
                        }
                        Err(e) => {
                            error!("Failed to push oracle prices: {}", e);
                        }
                    }
                }
                Err(e) => {
                    error!("Failed to fetch RedStone data packages: {}", e);
                }
            }
        } else {
            debug!(
                "Oracle update not needed: drift={}bps age={}s",
                drift_bps, age
            );
        }

        Ok(())
    }
}

/// Get current Unix timestamp
fn current_timestamp() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs()
}
