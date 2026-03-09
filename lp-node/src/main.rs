mod cli;
mod db;
mod engine;
mod evm;
mod events;
mod monero;

use alloy::primitives::Address;
use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use serde::Deserialize;
use std::env;
use std::fs;
use std::sync::Arc;
use tracing::{info, Level};
use tracing_subscriber::FmtSubscriber;

#[derive(Parser)]
#[command(name = "wrapsynth-lp")]
#[command(about = "WrapSynth LP Node - Manage your liquidity provider vault", long_about = None)]
struct Cli {
    #[command(subcommand)]
    command: Option<Commands>,
}

#[derive(Subcommand)]
enum Commands {
    /// Start the LP node server
    Start,
    /// Show vault information
    Info,
    /// Check vault health and collateralization ratio
    Health,
    /// Show pending mint/burn requests
    Pending,
    /// Show swap history
    History {
        #[arg(short, long, default_value_t = 10)]
        limit: usize,
    },
    /// Show database statistics
    DbStats,
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();

    // Initialize logging
    let subscriber = FmtSubscriber::builder()
        .with_max_level(Level::INFO)
        .with_target(false)
        .with_thread_ids(true)
        .finish();

    tracing::subscriber::set_global_default(subscriber)
        .context("Failed to set tracing subscriber")?;

    // Load configuration from config.toml and environment variables
    let config = Config::load()?;
    config.validate()?;

    // Initialize database
    let db = db::Database::open(&config.db_path)
        .context("Failed to open database")?;

    // Initialize EVM client
    let evm = Arc::new(
        evm::EvmClient::new(
            config.network_config.ws_url.clone(),
            config.private_key.clone(),
            config.network_config.vault_manager,
            config.lp_vault_address,
            config.network_config.pyth_hermes_url.clone(),
        )
        .await
        .context("Failed to initialize EVM client")?,
    );

    // Handle CLI commands
    match cli.command {
        Some(Commands::Info) => {
            let cli_handler = cli::LpCli::new(evm);
            cli_handler.vault_info().await?;
        }
        Some(Commands::Health) => {
            let cli_handler = cli::LpCli::new(evm);
            cli_handler.health_check().await?;
        }
        Some(Commands::Pending) => {
            let cli_handler = cli::LpCli::new(evm);
            cli_handler.pending_requests().await?;
        }
        Some(Commands::History { limit }) => {
            let cli_handler = cli::LpCli::new(evm);
            cli_handler.history(limit).await?;
        }
        Some(Commands::DbStats) => {
            let cli_handler = cli::LpCli::new(evm);
            cli_handler.db_stats(&db).await?;
        }
        Some(Commands::Start) | None => {
            // Start the LP node server
            info!("WrapSynth LP Node starting...");
            info!("Configuration loaded");
            info!("Network: {}", config.network_config.name);
            info!("LP Vault Address: {}", config.lp_vault_address);
            info!("VaultManager Address: {}", config.network_config.vault_manager);
            info!("Database Path: {}", config.db_path);
            info!("Database initialized");
            info!("EVM client initialized");

            // Initialize Monero client
            let monero = Arc::new(monero::MoneroClient::new(config.monero_config.rpc_url.clone()));
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
        }
    }

    Ok(())
}

#[derive(Debug, Deserialize)]
struct ConfigFile {
    gnosis: NetworkConfig,
    #[serde(default)]
    unichain_testnet: Option<NetworkConfig>,
    monero: MoneroConfig,
    lp_node: LpNodeConfig,
}

#[derive(Debug, Deserialize, Clone)]
struct NetworkConfig {
    chain_id: u64,
    name: String,
    rpc_url: String,
    ws_url: String,
    vault_manager: Address,
    wsxmr_token: Address,
    pyth_oracle: Address,
    pyth_hermes_url: String,
}

#[derive(Debug, Deserialize, Clone)]
struct MoneroConfig {
    rpc_url: String,
    network: String,
}

#[derive(Debug, Deserialize, Clone)]
struct LpNodeConfig {
    db_path: String,
    log_level: String,
}

/// Runtime configuration combining config file and environment variables
struct Config {
    network_config: NetworkConfig,
    monero_config: MoneroConfig,
    db_path: String,
    private_key: String,
    lp_vault_address: Address,
}

impl Config {
    /// Load configuration from config.toml and environment variables
    fn load() -> Result<Self> {
        // Read config file
        let config_path = env::var("CONFIG_PATH").unwrap_or_else(|_| "config.toml".to_string());
        let config_content = fs::read_to_string(&config_path)
            .with_context(|| format!("Failed to read config file: {}", config_path))?;
        let config_file: ConfigFile = toml::from_str(&config_content)
            .context("Failed to parse config.toml")?;

        // Determine which network to use
        let network = env::var("NETWORK").unwrap_or_else(|_| "gnosis".to_string());
        let network_config = match network.as_str() {
            "gnosis" => config_file.gnosis,
            "unichain" => config_file.unichain_testnet
                .context("Unichain testnet config not found in config.toml")?,
            _ => anyhow::bail!("Invalid NETWORK: {}. Must be 'gnosis' or 'unichain'", network),
        };

        // Load sensitive data from environment variables
        let private_key = env::var("PRIVATE_KEY")
            .context("PRIVATE_KEY environment variable not set")?;
        let lp_vault_address = env::var("LP_VAULT_ADDRESS")
            .context("LP_VAULT_ADDRESS environment variable not set")?
            .parse()
            .context("Invalid LP_VAULT_ADDRESS")?;

        // Allow overriding config file values with environment variables
        let monero_config = MoneroConfig {
            rpc_url: env::var("MONERO_RPC_URL")
                .unwrap_or(config_file.monero.rpc_url),
            network: config_file.monero.network,
        };

        let db_path = env::var("DB_PATH")
            .unwrap_or(config_file.lp_node.db_path);

        Ok(Self {
            network_config,
            monero_config,
            db_path,
            private_key,
            lp_vault_address,
        })
    }

    /// Validate the configuration
    fn validate(&self) -> Result<()> {
        if self.private_key.is_empty() {
            anyhow::bail!("PRIVATE_KEY cannot be empty");
        }

        if !self.network_config.ws_url.starts_with("ws://") && !self.network_config.ws_url.starts_with("wss://") {
            anyhow::bail!("WebSocket URL must start with ws:// or wss://");
        }

        if !self.monero_config.rpc_url.starts_with("http://") && !self.monero_config.rpc_url.starts_with("https://") {
            anyhow::bail!("MONERO_RPC_URL must start with http:// or https://");
        }

        Ok(())
    }
}
