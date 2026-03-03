use crate::db::{BurnStatus, BurnTask, Database, MintStatus, MintTask};
use crate::evm::EvmClient;
use crate::monero::MoneroClient;
use alloy::primitives::FixedBytes;
use anyhow::{Context, Result};
use k256::elliptic_curve::sec1::ToEncodedPoint;
use k256::SecretKey;
use rand::rngs::OsRng;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::time::{sleep, Duration};
use tracing::{debug, error, info, warn};

const MONERO_CONFIRMATIONS: u64 = 10;
const POLL_INTERVAL_SECS: u64 = 30;
const BURN_SAFETY_MARGIN_HOURS: u64 = 6; // Finalize 6 hours before deadline

/// The main engine that orchestrates atomic swaps
pub struct SwapEngine {
    db: Database,
    evm: Arc<EvmClient>,
    monero: Arc<MoneroClient>,
}

impl SwapEngine {
    pub fn new(db: Database, evm: Arc<EvmClient>, monero: Arc<MoneroClient>) -> Self {
        Self { db, evm, monero }
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
            let now = current_timestamp();
            let safety_deadline = burn.deadline - (BURN_SAFETY_MARGIN_HOURS * 3600);

            if now >= safety_deadline {
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

        for mut mint in mints {
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

    async fn handle_mint_pending(&self, mint: &mut MintTask) -> Result<()> {
        info!("Checking for XMR lock: {}", hex::encode(mint.request_id));

        // Verify the user has locked XMR on Monero
        let verified = self
            .monero
            .verify_mint_lock(mint.xmr_amount, &mint.claim_commitment, 1)
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
            .verify_mint_lock(mint.xmr_amount, &mint.claim_commitment, MONERO_CONFIRMATIONS)
            .await?;

        if verified {
            info!(
                "XMR lock confirmed for mint {}",
                hex::encode(mint.request_id)
            );

            // Call setMintReady on EVM
            let request_id = FixedBytes::from_slice(&mint.request_id);
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

    async fn handle_mint_ready(&self, mint: &mut MintTask) -> Result<()> {
        info!("Claiming XMR for mint: {}", hex::encode(mint.request_id));

        // In production, we would extract the secret from the user's claim transaction
        // For now, we'll use a placeholder
        let secret = [0u8; 32]; // PLACEHOLDER

        // Sweep the PTLC to claim XMR
        let tx_hash = self
            .monero
            .sweep_ptlc(&secret)
            .await
            .context("Failed to sweep PTLC on Monero")?;

        mint.revealed_secret = Some(secret);
        mint.monero_claim_txid = Some(tx_hash);
        mint.status = MintStatus::XmrClaimed;
        mint.updated_at = current_timestamp();
        self.db.update_mint_task(mint)?;

        info!("XMR claimed on Monero: {}", mint.monero_claim_txid.as_ref().unwrap());
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
            "Vault health - Collateral: {}, Debt: {}, Ratio: {:.2}%",
            vault.collateral_amount, vault.debt_amount, ratio
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
}

/// Get current Unix timestamp
fn current_timestamp() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs()
}
