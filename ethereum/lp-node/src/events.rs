use crate::db::{BurnStatus, BurnTask, Database, MintStatus, MintTask};
use crate::evm::EvmClient;
use crate::monero::MoneroClient;
use anyhow::Result;
use futures::StreamExt;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tracing::{error, info, warn};

/// Event listener that subscribes to EVM events and creates tasks
pub struct EventListener {
    db: Database,
    evm: Arc<EvmClient>,
    monero: Arc<MoneroClient>,
    lp_vault_address: [u8; 20],
}

impl EventListener {
    pub fn new(db: Database, evm: Arc<EvmClient>, monero: Arc<MoneroClient>, lp_vault_address: [u8; 20]) -> Self {
        Self {
            db,
            evm,
            monero,
            lp_vault_address,
        }
    }

    /// Scan for historical events and process pending requests
    pub async fn scan_historical_events(&self, from_block: u64) -> Result<()> {
        info!("Scanning for historical events from block {}", from_block);

        // Query historical mint events
        let mint_logs = self.evm.get_historical_mint_events(from_block).await?;
        info!("Found {} historical MintInitiated events", mint_logs.len());
        
        for log in &mint_logs {
            if let Err(e) = self.handle_mint_initiated_event(log).await {
                error!("Error processing historical MintInitiated event: {}", e);
            }
        }

        // Query historical mint finalized events
        let finalized_logs = self.evm.get_historical_mint_finalized_events(from_block).await?;
        info!("Found {} historical MintFinalized events", finalized_logs.len());

        for log in &finalized_logs {
            if let Err(e) = self.handle_mint_finalized_event(log).await {
                error!("Error processing historical MintFinalized event: {}", e);
            }
        }

        // Query historical burn events
        let burn_logs = self.evm.get_historical_burn_events(from_block).await?;
        info!("Found {} historical BurnRequested events", burn_logs.len());
        
        for log in &burn_logs {
            if let Err(e) = self.handle_burn_requested_event(log).await {
                error!("Error processing historical BurnRequested event: {}", e);
            }
        }

        info!("Historical event scan complete");
        Ok(())
    }

    /// Start listening for events
    pub async fn start(self: Arc<Self>) -> Result<()> {
        info!("Starting event listener");

        // Scan for historical events from the last ~3 hours worth of blocks
        let current_block = self.evm.get_block_number().await.unwrap_or(0);
        let blocks_per_hour = 720; // ~5 second blocks on Gnosis
        let from_block = current_block.saturating_sub(blocks_per_hour * 3);
        
        if let Err(e) = self.scan_historical_events(from_block).await {
            error!("Error scanning historical events: {}", e);
        }

        // Spawn burn requested event listener
        let listener = self.clone();
        tokio::spawn(async move {
            if let Err(e) = listener.listen_burn_requested_events().await {
                error!("Burn requested event listener error: {}", e);
            }
        });

        // Spawn burn committed event listener
        let listener = self.clone();
        tokio::spawn(async move {
            if let Err(e) = listener.listen_burn_committed_events().await {
                error!("Burn committed event listener error: {}", e);
            }
        });

        // Spawn mint event listener
        let listener = self.clone();
        tokio::spawn(async move {
            if let Err(e) = listener.listen_mint_events().await {
                error!("Mint event listener error: {}", e);
            }
        });

        // Spawn mint finalized event listener
        let listener = self.clone();
        tokio::spawn(async move {
            if let Err(e) = listener.listen_mint_finalized_events().await {
                error!("Mint finalized event listener error: {}", e);
            }
        });

        info!("Event listeners started");
        Ok(())
    }

    /// Listen for BurnRequested events with auto-reconnect on disconnect/reorg
    async fn listen_burn_requested_events(&self) -> Result<()> {
        info!("Listening for BurnRequested events");

        loop {
            match self.evm.subscribe_burn_requested().await {
                Ok(mut stream) => {
                    info!("BurnRequested event subscription established");
                    while let Some(log) = stream.next().await {
                        if let Err(e) = self.handle_burn_requested_event(&log).await {
                            error!("Error handling BurnRequested event: {}", e);
                        }
                    }
                    warn!("BurnRequested event stream ended, reconnecting in 5s...");
                }
                Err(e) => {
                    error!(
                        "Failed to subscribe to BurnRequested events: {}, retrying in 5s...",
                        e
                    );
                }
            }
            tokio::time::sleep(tokio::time::Duration::from_secs(5)).await;
        }
    }

    /// Listen for BurnCommitted events with auto-reconnect on disconnect/reorg
    async fn listen_burn_committed_events(&self) -> Result<()> {
        info!("Listening for BurnCommitted events");

        loop {
            match self.evm.subscribe_burn_committed().await {
                Ok(mut stream) => {
                    info!("BurnCommitted event subscription established");
                    while let Some(log) = stream.next().await {
                        if let Err(e) = self.handle_burn_committed_event(&log).await {
                            error!("Error handling BurnCommitted event: {}", e);
                        }
                    }
                    warn!("BurnCommitted event stream ended, reconnecting in 5s...");
                }
                Err(e) => {
                    error!(
                        "Failed to subscribe to BurnCommitted events: {}, retrying in 5s...",
                        e
                    );
                }
            }
            tokio::time::sleep(tokio::time::Duration::from_secs(5)).await;
        }
    }

    /// Listen for MintInitiated events with auto-reconnect on disconnect/reorg
    async fn listen_mint_events(&self) -> Result<()> {
        info!("Listening for MintInitiated events");

        loop {
            match self.evm.subscribe_mint_initiated().await {
                Ok(mut stream) => {
                    info!("Mint event subscription established");
                    while let Some(log) = stream.next().await {
                        if let Err(e) = self.handle_mint_initiated_event(&log).await {
                            error!("Error handling MintInitiated event: {}", e);
                        }
                    }
                    warn!("Mint event stream ended, reconnecting in 5s...");
                }
                Err(e) => {
                    error!(
                        "Failed to subscribe to MintInitiated events: {}, retrying in 5s...",
                        e
                    );
                }
            }
            tokio::time::sleep(tokio::time::Duration::from_secs(5)).await;
        }
    }

    /// Listen for MintFinalized events with auto-reconnect on disconnect/reorg
    async fn listen_mint_finalized_events(&self) -> Result<()> {
        info!("Listening for MintFinalized events");

        loop {
            match self.evm.subscribe_mint_finalized().await {
                Ok(mut stream) => {
                    info!("Mint finalized event subscription established");
                    while let Some(log) = stream.next().await {
                        if let Err(e) = self.handle_mint_finalized_event(&log).await {
                            error!("Error handling MintFinalized event: {}", e);
                        }
                    }
                    warn!("Mint finalized event stream ended, reconnecting in 5s...");
                }
                Err(e) => {
                    error!(
                        "Failed to subscribe to MintFinalized events: {}, retrying in 5s...",
                        e
                    );
                }
            }
            tokio::time::sleep(tokio::time::Duration::from_secs(5)).await;
        }
    }

    /// Handle a BurnRequested event
    async fn handle_burn_requested_event(&self, log: &alloy::rpc::types::Log) -> Result<()> {
        let event = self.evm.parse_burn_requested(log)?;

        // Check if this burn is for our vault
        let lp_vault_bytes: [u8; 20] = event.lpVault.into();
        if lp_vault_bytes != self.lp_vault_address {
            return Ok(());
        }

        let claim_commitment: [u8; 32] = event.claimCommitment.into();
        
        info!(
            "BurnRequested event: requestId={}, user={}, wsxmrAmount={}, xmrAmount={}, claimCommitment={}",
            hex::encode(event.requestId),
            event.user,
            event.wsxmrAmount,
            event.xmrAmount,
            hex::encode(claim_commitment)
        );

        // Generate swap keys from user's claim commitment (same as mint flow)
        let swap_keys = self.monero.generate_swap_keys(&claim_commitment)?;
        info!(
            "Derived swap deposit address for burn: {}",
            swap_keys.deposit_address
        );

        // Create a burn task
        let task = BurnTask {
            request_id: event.requestId.into(),
            user: event.user.into(),
            lp_vault: lp_vault_bytes,
            wsxmr_amount: event.wsxmrAmount.to::<u64>(),
            xmr_amount: event.xmrAmount.to::<u64>(),
            locked_collateral: 0, // Will be calculated
            deadline: self.evm.get_block_number().await.unwrap_or(0) + 720, // default burn timeout blocks
            status: BurnStatus::Requested,
            created_at: current_timestamp(),
            updated_at: current_timestamp(),
            secret: None,
            secret_hash: None,
            monero_lock_txid: None,
            commit_tx_hash: None,
            claim_commitment: Some(claim_commitment),
        };

        self.db.insert_burn_task(&task)?;
        info!("Burn task created: {}", hex::encode(task.request_id));

        Ok(())
    }

    /// Handle a BurnCommitted event
    async fn handle_burn_committed_event(&self, log: &alloy::rpc::types::Log) -> Result<()> {
        let event = self.evm.parse_burn_committed(log)?;

        info!(
            "BurnCommitted event: requestId={}, deadline={}",
            hex::encode(event.requestId),
            event.deadline
        );

        // Update the burn task status from Proposed to Committed
        let request_id: [u8; 32] = event.requestId.into();
        
        if let Some(mut burn) = self.db.get_burn_task(&request_id)? {
            if burn.status == BurnStatus::Proposed {
                burn.status = BurnStatus::Committed;
                burn.deadline = event.deadline.to::<u64>();
                burn.updated_at = current_timestamp();
                self.db.update_burn_task(&burn)?;
                
                info!(
                    "Burn task {} status updated to Committed",
                    hex::encode(request_id)
                );
            } else {
                warn!(
                    "Received BurnCommitted for request {} but status is {:?}, not Proposed",
                    hex::encode(request_id),
                    burn.status
                );
            }
        } else {
            warn!(
                "Received BurnCommitted event for unknown request: {}",
                hex::encode(request_id)
            );
        }

        Ok(())
    }

    /// Handle a MintInitiated event
    async fn handle_mint_initiated_event(&self, log: &alloy::rpc::types::Log) -> Result<()> {
        let event = self.evm.parse_mint_initiated(log)?;

        // Check if this mint is for our vault
        let lp_vault_bytes: [u8; 20] = event.lpVault.into();
        if lp_vault_bytes != self.lp_vault_address {
            return Ok(());
        }

        info!(
            "MintInitiated event: requestId={}, initiator={}, xmrAmount={}, wsxmrAmount={}",
            hex::encode(event.requestId),
            event.initiator,
            event.xmrAmount,
            event.wsxmrAmount
        );

        // Generate atomic swap keys for Farcaster protocol
        let claim_commitment: [u8; 32] = event.claimCommitment.into();
        let user_public_key: [u8; 32] = event.userPublicKey.into();
        let swap_keys = self.monero.generate_swap_keys_with_pubkey(&claim_commitment, &user_public_key)?;
        
        info!(
            "Generated swap keys - Deposit address: {}",
            swap_keys.deposit_address
        );

        // Submit LP's public keys on-chain so user can compute deposit address
        let request_id_bytes: [u8; 32] = event.requestId.into();
        let lp_public_spend_bytes = swap_keys.lp_public_spend.as_bytes();
        let lp_public_view_bytes = swap_keys.lp_public_view.as_bytes();
        let mut lp_public_spend_array = [0u8; 32];
        let mut lp_public_view_array = [0u8; 32];
        lp_public_spend_array.copy_from_slice(lp_public_spend_bytes);
        lp_public_view_array.copy_from_slice(lp_public_view_bytes);
        
        // Check if LP key was already provided or if mint has moved past PENDING status
        // (to avoid revert on historical event replay)
        let existing_key = self.evm.get_lp_public_key(request_id_bytes.into()).await;
        let key_already_provided = existing_key.is_ok() && 
            existing_key.unwrap() != alloy::primitives::FixedBytes::from([0u8; 32]);
        
        let mint_status = self.evm.get_mint_request_status(request_id_bytes.into()).await;
        let is_still_pending = mint_status.as_ref().map(|s| *s == 1).unwrap_or(false); // 1 = PENDING
        
        if !key_already_provided && is_still_pending {
            let mut last_error = None;
            for attempt in 1..=3 {
                match self.evm.provide_lp_key(
                    request_id_bytes.into(),
                    lp_public_spend_array.into(),
                    lp_public_view_array.into()
                ).await {
                    Ok(tx_hash) => {
                        info!("LP key submitted on-chain: {:?}", tx_hash);
                        last_error = None;
                        break;
                    }
                    Err(e) => {
                        if attempt < 3 {
                            warn!("Failed to submit LP key on-chain (attempt {}/{}): {}, retrying in 3s...", attempt, 3, e);
                            last_error = Some(e);
                            tokio::time::sleep(tokio::time::Duration::from_secs(3)).await;
                        } else {
                            tracing::error!("Failed to submit LP key on-chain after 3 attempts: {}", e);
                            last_error = Some(e);
                        }
                    }
                }
            }
        } else {
            if !is_still_pending {
                info!("Mint request no longer in PENDING status (status: {:?}), skipping LP key submission", mint_status);
            } else {
                info!("LP key already provided for this request, skipping on-chain submission");
            }
        }

        // Check if mint task already exists (don't overwrite existing state)
        let request_id_bytes: [u8; 32] = event.requestId.into();
        if let Some(existing) = self.db.get_mint_task(&request_id_bytes)? {
            info!(
                "Mint task {} already exists in DB with status {:?}, skipping historical event replay",
                hex::encode(request_id_bytes),
                existing.status
            );
            return Ok(());
        }

        // Create a mint task with swap keys
        let task = MintTask {
            request_id: event.requestId.into(),
            user: event.initiator.into(),
            lp_vault: lp_vault_bytes,
            xmr_amount: event.xmrAmount.to::<u64>(),
            wsxmr_amount: event.wsxmrAmount.to::<u64>(),
            claim_commitment,
            timeout: event.timeout.to::<u64>(),
            status: MintStatus::Pending,
            created_at: current_timestamp(),
            updated_at: current_timestamp(),
            revealed_secret: None,
            monero_claim_txid: None,
            lp_private_spend: {
                let bytes = swap_keys.lp_private_spend.as_bytes();
                let mut array = [0u8; 32];
                array.copy_from_slice(bytes);
                Some(array)
            },
            lp_private_view: {
                let bytes = swap_keys.lp_private_view.as_bytes();
                let mut array = [0u8; 32];
                array.copy_from_slice(bytes);
                Some(array)
            },
            lp_public_spend: {
                let bytes = swap_keys.lp_public_spend.as_bytes();
                let mut array = [0u8; 32];
                array.copy_from_slice(bytes);
                Some(array)
            },
            lp_public_view: {
                let bytes = swap_keys.lp_public_view.as_bytes();
                let mut array = [0u8; 32];
                array.copy_from_slice(bytes);
                Some(array)
            },
            deposit_address: Some(swap_keys.deposit_address.to_string()),
        };

        self.db.insert_mint_task(&task)?;
        info!("Mint task created: {}", hex::encode(task.request_id));

        Ok(())
    }

    /// Handle a MintFinalized event
    async fn handle_mint_finalized_event(&self, log: &alloy::rpc::types::Log) -> Result<()> {
        let event = self.evm.parse_mint_finalized(log)?;

        let request_id: [u8; 32] = event.requestId.into();
        let secret: [u8; 32] = event.secret.into();

        info!(
            "MintFinalized event: requestId={}, secret={}",
            hex::encode(request_id),
            hex::encode(secret)
        );

        // Look up the mint task in the database
        let mut mint = match self.db.get_mint_task(&request_id)? {
            Some(task) => task,
            None => {
                warn!("No mint task found for requestId {}, skipping", hex::encode(request_id));
                return Ok(());
            }
        };

        // Only process if the mint is in Ready state (waiting for user to finalize)
        if mint.status != MintStatus::Ready {
            info!(
                "Mint {} is not in Ready status (current: {:?}), skipping secret storage",
                hex::encode(request_id),
                mint.status
            );
            return Ok(());
        }

        // Store the revealed secret and transition to XmrClaimed
        mint.revealed_secret = Some(secret);
        mint.status = MintStatus::XmrClaimed;
        mint.updated_at = current_timestamp();
        self.db.update_mint_task(&mint)?;

        info!(
            "Mint {} secret stored, status updated to XmrClaimed. Engine will sweep XMR on next poll.",
            hex::encode(request_id)
        );

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
