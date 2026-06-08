mod api;
mod arbitrage;
mod cli;
mod db;
mod engine;
mod evm;
mod events;
mod monero;
mod oracle;
mod quote;

use alloy::primitives::{Address, U256};
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
    /// Create a new LP vault (onboarding step 1)
    CreateVault,
    /// Deposit collateral into your vault (onboarding step 2)
    DepositCollateral {
        /// Amount of collateral to deposit (in sDAI)
        #[arg(short, long)]
        amount: String,
    },
    /// Withdraw collateral from your vault
    WithdrawCollateral {
        /// Amount of collateral to withdraw (in sDAI)
        #[arg(short, long)]
        amount: String,
        /// Unwrap wxDAI to native xDAI after withdrawal
        #[arg(long, default_value_t = false)]
        unwrap: bool,
    },
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
    /// Scan for pending requests and process them
    ProcessPending {
        /// Number of hours to look back (default: 3)
        #[arg(short, long, default_value_t = 3)]
        hours: u64,
    },
}

#[tokio::main]
async fn main() -> Result<()> {
    dotenv::dotenv().ok();
    
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
        Some(Commands::CreateVault) => {
            let cli_handler = cli::LpCli::new(evm);
            cli_handler.create_vault().await?;
        }
        Some(Commands::DepositCollateral { amount }) => {
            let cli_handler = cli::LpCli::new(evm);
            cli_handler.deposit_collateral(&amount).await?;
        }
        Some(Commands::WithdrawCollateral { amount, unwrap }) => {
            let cli_handler = cli::LpCli::new(evm);
            cli_handler.withdraw_collateral(&amount, unwrap).await?;
        }
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
        Some(Commands::ProcessPending { hours }) => {
            info!("Scanning for pending requests from the last {} hours", hours);
            
            // Initialize Monero client
            let wallet_rpc_url = env::var("MONERO_WALLET_RPC_URL").ok();
            let monero = Arc::new(
                monero::MoneroClient::new_with_wallet_rpc(
                    config.monero_config.daemon_url.clone(),
                    config.monero_private_key.clone(),
                    wallet_rpc_url,
                )
                .context("Failed to initialize Monero client")?
            );
            
            // Initialize event listener
            let lp_vault_bytes: [u8; 20] = config.lp_vault_address.into();
            let event_listener = Arc::new(events::EventListener::new(
                db.clone(),
                evm.clone(),
                monero.clone(),
                lp_vault_bytes,
            ));
            
            // Initialize swap engine (no arbitrage in process-pending mode)
            let swap_engine = Arc::new(engine::SwapEngine::new(
                db.clone(), 
                evm.clone(), 
                monero.clone(),
                config.oracle_config.is_price_pusher,
                None,
            ));
            
            // Calculate from_block based on hours
            let current_block = evm.get_block_number().await.unwrap_or(0);
            let blocks_per_hour = 720; // ~5 second blocks on Gnosis
            let from_block = current_block.saturating_sub(blocks_per_hour * hours);
            
            info!("Scanning from block {} to current block {}", from_block, current_block);
            
            // Scan historical events
            event_listener.scan_historical_events(from_block).await?;
            
            // Start swap engine to process the tasks
            swap_engine.start().await?;
            
            info!("Processing pending requests...");
            
            // Give it some time to process
            tokio::time::sleep(tokio::time::Duration::from_secs(5)).await;
            
            info!("✅ Pending request scan complete");
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
            let wallet_rpc_url = env::var("MONERO_WALLET_RPC_URL").ok();
            let monero = Arc::new(
                monero::MoneroClient::new_with_wallet_rpc(
                    config.monero_config.daemon_url.clone(),
                    config.monero_private_key.clone(),
                    wallet_rpc_url,
                )
                .context("Failed to initialize Monero client")?
            );
            info!("Monero client initialized");

            // Display Monero address
            match monero.get_address() {
                Ok(address) => info!("Monero wallet address: {}", address),
                Err(e) => {
                    tracing::warn!("Failed to get Monero address: {}", e);
                }
            }

            // Initialize event listener
            let lp_vault_bytes: [u8; 20] = config.lp_vault_address.into();
            let event_listener = Arc::new(events::EventListener::new(
                db.clone(),
                evm.clone(),
                monero.clone(),
                lp_vault_bytes,
            ));

            // Initialize oracle client
            let oracle = Arc::new(oracle::OracleClient::new());
            info!("Oracle client initialized");

            // Initialize quote generator
            let quote_gen = Arc::new(
                quote::QuoteGenerator::new(&config.private_key, config.lp_vault_address)
                    .context("Failed to initialize quote generator")?
            );
            info!("Quote generator initialized");

            // Initialize arbitrage bot if enabled
            let arbitrage_bot = config.arbitrage_config.as_ref().and_then(|cfg| {
                if cfg.enabled {
                    info!("Arbitrage bot enabled");
                    let max_sdai = cfg.max_trade_sdai.parse::<u128>().unwrap_or(0);
                    let max_wsxmr = cfg.max_trade_wsxmr.parse::<u128>().unwrap_or(0);
                    Some(Arc::new(arbitrage::ArbitrageBot::new(
                        evm.clone(),
                        cfg.pool_address,
                        config.network_config.wsxmr_token,
                        cfg.sdai_address,
                        cfg.swap_helper,
                        cfg.factory_address,
                        cfg.threshold_bps,
                        U256::from(max_sdai),
                        U256::from(max_wsxmr),
                        cfg.slippage_bps,
                        cfg.poll_interval_secs,
                        cfg.min_profit_bps,
                    )))
                } else {
                    info!("Arbitrage bot disabled");
                    None
                }
            });

            // Initialize swap engine with oracle config
            let swap_engine = Arc::new(engine::SwapEngine::new(
                db.clone(), 
                evm.clone(), 
                monero.clone(),
                config.oracle_config.is_price_pusher,
                arbitrage_bot,
            ));

            // Start API server in background
            let api_db = Arc::new(db.clone());
            let api_evm = evm.clone();
            let api_monero = monero.clone();
            let api_oracle = oracle.clone();
            let api_quote_gen = quote_gen.clone();
            let api_config = api::ApiConfig {
                port: config.api_config.port,
                admin_secret: config.admin_config.secret.clone(),
                quote_ttl_seconds: config.quote_config.ttl_seconds,
                min_xmr_amount: config.quote_config.min_xmr_amount,
                max_xmr_amount: config.quote_config.max_xmr_amount,
                mint_fee_bps: config.quote_config.mint_fee_bps,
                burn_reward_bps: config.quote_config.burn_reward_bps,
                griefing_deposit_wei: config.quote_config.griefing_deposit_wei.clone(),
                mint_ready_bond_wei: config.quote_config.mint_ready_bond_wei.clone(),
            };
            let api_lp_vault = config.lp_vault_address;
            
            tokio::spawn(async move {
                if let Err(e) = api::start_api_server(
                    api_db,
                    api_evm,
                    api_monero,
                    api_oracle,
                    api_quote_gen,
                    api_config,
                    api_lp_vault,
                ).await {
                    tracing::error!("API server error: {}", e);
                }
            });
            info!("API server started on port {}", config.api_config.port);

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
    api: ApiConfig,
    admin: AdminConfig,
    quote: QuoteConfig,
    oracle: OracleConfig,
    #[serde(default)]
    arbitrage: Option<ArbitrageConfig>,
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
    daemon_url: String,
    network: String,
}

#[derive(Debug, Deserialize, Clone)]
struct LpNodeConfig {
    db_path: String,
    log_level: String,
}

#[derive(Debug, Deserialize, Clone)]
struct ApiConfig {
    port: u16,
    rate_limit_per_minute: u64,
}

#[derive(Debug, Deserialize, Clone)]
struct AdminConfig {
    secret: String,
}

#[derive(Debug, Deserialize, Clone)]
struct QuoteConfig {
    ttl_seconds: u64,
    min_xmr_amount: u64,
    max_xmr_amount: u64,
    mint_fee_bps: u16,
    burn_reward_bps: u16,
    griefing_deposit_wei: String,
    mint_ready_bond_wei: String,
}

#[derive(Debug, Deserialize, Clone)]
struct OracleConfig {
    is_price_pusher: bool,
    push_threshold_bps: u16,
    max_age_secs: u64,
    poll_interval_secs: u64,
}

#[derive(Debug, Deserialize, Clone)]
struct ArbitrageConfig {
    enabled: bool,
    pool_address: Address,
    swap_helper: Address,
    sdai_address: Address,
    factory_address: Address,
    threshold_bps: u16,
    max_trade_sdai: String,
    max_trade_wsxmr: String,
    slippage_bps: u16,
    poll_interval_secs: u64,
    min_profit_bps: u16,
}

/// Runtime configuration combining config file and environment variables
struct Config {
    network_config: NetworkConfig,
    monero_config: MoneroConfig,
    db_path: String,
    private_key: String,
    lp_vault_address: Address,
    monero_private_key: String,
    api_config: ApiConfig,
    admin_config: AdminConfig,
    quote_config: QuoteConfig,
    oracle_config: OracleConfig,
    arbitrage_config: Option<ArbitrageConfig>,
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
        
        // Derive LP vault address from private key
        let lp_vault_address = {
            use alloy::signers::local::PrivateKeySigner;
            let signer: PrivateKeySigner = private_key.parse()
                .context("Invalid PRIVATE_KEY format")?;
            signer.address()
        };
        
        let monero_private_key = env::var("MONERO_PRIVATE_KEY")
            .context("MONERO_PRIVATE_KEY environment variable not set")?;

        // Allow overriding config file values with environment variables
        let monero_config = MoneroConfig {
            daemon_url: env::var("MONERO_DAEMON_URL")
                .unwrap_or(config_file.monero.daemon_url),
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
            monero_private_key,
            api_config: config_file.api,
            admin_config: config_file.admin,
            quote_config: config_file.quote,
            oracle_config: config_file.oracle,
            arbitrage_config: config_file.arbitrage,
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

        if !self.monero_config.daemon_url.starts_with("http://") && !self.monero_config.daemon_url.starts_with("https://") {
            anyhow::bail!("MONERO_DAEMON_URL must start with http:// or https://");
        }

        if self.monero_private_key.is_empty() {
            anyhow::bail!("MONERO_PRIVATE_KEY cannot be empty");
        }

        Ok(())
    }
}
