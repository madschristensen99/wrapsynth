mod db;
mod engine;
mod evm;
mod events;
mod monero;

use alloy::primitives::Address;
use anyhow::{Context, Result};
use std::env;
use std::sync::Arc;
use tracing::{info, Level};
use tracing_subscriber::FmtSubscriber;

#[tokio::main]
async fn main() -> Result<()> {
    // Initialize logging
    let subscriber = FmtSubscriber::builder()
        .with_max_level(Level::INFO)
        .with_target(false)
        .with_thread_ids(true)
        .finish();

    tracing::subscriber::set_global_default(subscriber)
        .context("Failed to set tracing subscriber")?;

    info!("WrapSynth LP Node starting...");

    // Load configuration from environment variables
    let config = Config::from_env()?;
    config.validate()?;

    info!("Configuration loaded");
    info!("LP Vault Address: {}", config.lp_vault_address);
    info!("VaultManager Address: {}", config.vault_manager_address);
    info!("Database Path: {}", config.db_path);

    // Initialize database
    let db = db::Database::open(&config.db_path)
        .context("Failed to open database")?;
    info!("Database initialized");

    // Initialize EVM client
    let evm = Arc::new(
        evm::EvmClient::new(
            config.evm_ws_url.clone(),
            config.private_key.clone(),
            config.vault_manager_address,
            config.lp_vault_address,
            config.pyth_hermes_url.clone(),
        )
        .await
        .context("Failed to initialize EVM client")?,
    );
    info!("EVM client initialized");

    // Initialize Monero client
    let monero = Arc::new(monero::MoneroClient::new(config.monero_rpc_url.clone()));
    info!("Monero client initialized");

    // Test Monero connection
    match monero.get_address().await {
        Ok(address) => info!("Monero wallet address: {}", address),
        Err(e) => {
            tracing::warn!("Failed to connect to Monero wallet: {}", e);
            tracing::warn!("Make sure monero-wallet-rpc is running");
        }
    }

    // Initialize event listener
    let lp_vault_bytes: [u8; 20] = config.lp_vault_address.into();
    let event_listener = Arc::new(events::EventListener::new(
        db.clone(),
        evm.clone(),
        lp_vault_bytes,
    ));

    // Initialize swap engine
    let swap_engine = Arc::new(engine::SwapEngine::new(db.clone(), evm.clone(), monero.clone()));

    // Start event listener
    event_listener
        .start()
        .await
        .context("Failed to start event listener")?;

    // Start swap engine
    swap_engine
        .start()
        .await
        .context("Failed to start swap engine")?;

    info!("LP Node is running");
    info!("Press Ctrl+C to stop");

    // Keep the main task alive
    tokio::signal::ctrl_c()
        .await
        .context("Failed to listen for Ctrl+C")?;

    info!("Shutting down...");
    Ok(())
}

/// Configuration loaded from environment variables
struct Config {
    /// Path to the sled database
    db_path: String,
    /// EVM WebSocket URL
    evm_ws_url: String,
    /// Private key for the LP account
    private_key: String,
    /// VaultManager contract address
    vault_manager_address: Address,
    /// LP vault address (our address)
    lp_vault_address: Address,
    /// Monero RPC URL
    monero_rpc_url: String,
    /// Pyth Hermes API URL for price feeds
    pyth_hermes_url: String,
}

impl Config {
    /// Load configuration from environment variables
    fn from_env() -> Result<Self> {
        Ok(Self {
            db_path: env::var("DB_PATH").unwrap_or_else(|_| "./lp-node-db".to_string()),
            evm_ws_url: env::var("EVM_WS_URL")
                .context("EVM_WS_URL environment variable not set")?,
            private_key: env::var("PRIVATE_KEY")
                .context("PRIVATE_KEY environment variable not set")?,
            vault_manager_address: env::var("VAULT_MANAGER_ADDRESS")
                .context("VAULT_MANAGER_ADDRESS environment variable not set")?
                .parse()
                .context("Invalid VAULT_MANAGER_ADDRESS")?,
            lp_vault_address: env::var("LP_VAULT_ADDRESS")
                .context("LP_VAULT_ADDRESS environment variable not set")?
                .parse()
                .context("Invalid LP_VAULT_ADDRESS")?,
            monero_rpc_url: env::var("MONERO_RPC_URL")
                .unwrap_or_else(|_| "http://127.0.0.1:18082/json_rpc".to_string()),
            pyth_hermes_url: env::var("PYTH_HERMES_URL")
                .unwrap_or_else(|_| "https://hermes.pyth.network".to_string()),
        })
    }

    /// Validate the configuration
    fn validate(&self) -> Result<()> {
        if self.private_key.is_empty() {
            anyhow::bail!("PRIVATE_KEY cannot be empty");
        }

        if !self.evm_ws_url.starts_with("ws://") && !self.evm_ws_url.starts_with("wss://") {
            anyhow::bail!("EVM_WS_URL must start with ws:// or wss://");
        }

        if !self.monero_rpc_url.starts_with("http://") && !self.monero_rpc_url.starts_with("https://") {
            anyhow::bail!("MONERO_RPC_URL must start with http:// or https://");
        }

        Ok(())
    }
}
