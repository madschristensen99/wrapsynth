use crate::db::{BurnStatus, BurnTask, Database, MintStatus, MintTask};
use crate::evm::EvmClient;
use crate::monero::MoneroClient;
use anyhow::{Context, Result};
use futures::StreamExt;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tracing::{error, info};

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

        // Spawn burn event listener
        let listener = self.clone();
        tokio::spawn(async move {
            if let Err(e) = listener.listen_burn_events().await {
                error!("Burn event listener error: {}", e);
            }
        });

        // Spawn mint event listener
        let listener = self.clone();
        tokio::spawn(async move {
            if let Err(e) = listener.listen_mint_events().await {
                error!("Mint event listener error: {}", e);
            }
        });

        info!("Event listeners started");
        Ok(())
    }

    /// Listen for BurnRequested events
    async fn listen_burn_events(&self) -> Result<()> {
        info!("Listening for BurnRequested events");

        let mut stream = self
            .evm
            .subscribe_burn_requested()
            .await
            .context("Failed to subscribe to BurnRequested events")?;

        while let Some(log) = stream.next().await {
            if let Err(e) = self.handle_burn_requested_event(&log).await {
                error!("Error handling BurnRequested event: {}", e);
            }
        }

        Ok(())
    }

    /// Listen for MintInitiated events
    async fn listen_mint_events(&self) -> Result<()> {
        info!("Listening for MintInitiated events");

        let mut stream = self
            .evm
            .subscribe_mint_initiated()
            .await
            .context("Failed to subscribe to MintInitiated events")?;

        while let Some(log) = stream.next().await {
            if let Err(e) = self.handle_mint_initiated_event(&log).await {
                error!("Error handling MintInitiated event: {}", e);
            }
        }

        Ok(())
    }

    /// Handle a BurnRequested event
    async fn handle_burn_requested_event(&self, log: &alloy::rpc::types::Log) -> Result<()> {
        let event = self.evm.parse_burn_requested(log)?;

        // Check if this burn is for our vault
        let lp_vault_bytes: [u8; 20] = event.lpVault.into();
        if lp_vault_bytes != self.lp_vault_address {
            return Ok(());
        }

        info!(
            "BurnRequested event: requestId={}, user={}, wsxmrAmount={}, xmrAmount={}",
            hex::encode(event.requestId),
            event.user,
            event.wsxmrAmount,
            event.xmrAmount
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
        };

        self.db.insert_burn_task(&task)?;
        info!("Burn task created: {}", hex::encode(task.request_id));

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
        let swap_keys = self.monero.generate_swap_keys(&claim_commitment)?;
        
        info!(
            "Generated swap keys - Deposit address: {}",
            swap_keys.deposit_address
        );

        // Submit LP's public key on-chain so user can compute deposit address
        let request_id_bytes: [u8; 32] = event.requestId.into();
        let lp_public_spend_bytes = swap_keys.lp_public_spend.as_bytes();
        let mut lp_public_key_array = [0u8; 32];
        lp_public_key_array.copy_from_slice(lp_public_spend_bytes);
        
        // Check if LP key was already provided (to avoid revert on historical event replay)
        let existing_key = self.evm.get_lp_public_key(request_id_bytes.into()).await;
        let key_already_provided = existing_key.is_ok() && 
            existing_key.unwrap() != alloy::primitives::FixedBytes::from([0u8; 32]);
        
        if !key_already_provided {
            match self.evm.provide_lp_key(
                request_id_bytes.into(),
                lp_public_key_array.into()
            ).await {
                Ok(tx_hash) => {
                    info!("LP key submitted on-chain: {:?}", tx_hash);
                }
                Err(e) => {
                    tracing::error!("Failed to submit LP key on-chain: {}", e);
                    // Continue anyway - we still store it in DB for API fallback
                }
            }
        } else {
            info!("LP key already provided for this request, skipping on-chain submission");
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
            deposit_address: Some(swap_keys.deposit_address.to_string()),
        };

        self.db.insert_mint_task(&task)?;
        info!("Mint task created: {}", hex::encode(task.request_id));

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
