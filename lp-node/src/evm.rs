use alloy::network::{EthereumWallet};
use alloy::primitives::{Address, Bytes, FixedBytes, U256};
use alloy::providers::{Provider, ProviderBuilder, WsConnect};
use alloy::pubsub::SubscriptionStream;
use alloy::rpc::types::{Filter, Log};
use alloy::signers::local::PrivateKeySigner;
use alloy::sol;
use alloy::sol_types::SolEvent;
use anyhow::{Context, Result};
use std::sync::Arc;
use tokio::sync::RwLock;
use tracing::{info, warn};

// Define contract ABIs using Alloy's sol! macro
sol! {
    #[sol(rpc)]
    contract ERC20 {
        function approve(address spender, uint256 amount) external returns (bool);
        function allowance(address owner, address spender) external view returns (uint256);
        function balanceOf(address account) external view returns (uint256);
    }
    
    #[sol(rpc)]
    contract WETH9 {
        function deposit() external payable;
        function withdraw(uint256 amount) external;
    }
    
    #[sol(rpc)]
    contract VaultManager {
        // Events
        event BurnRequested(
            bytes32 indexed requestId,
            address indexed user,
            address indexed lpVault,
            uint256 wsxmrAmount,
            uint256 xmrAmount
        );

        event BurnCommitted(
            bytes32 indexed requestId,
            bytes32 secretHash,
            uint256 deadline
        );

        event BurnFinalized(
            bytes32 indexed requestId,
            bytes32 secret
        );

        event MintInitiated(
            bytes32 indexed requestId,
            address indexed user,
            address indexed lpVault,
            uint256 xmrAmount,
            uint256 wsxmrAmount,
            bytes32 claimCommitment,
            uint256 timeout
        );

        event MintReady(
            bytes32 indexed requestId
        );

        event MintFinalized(
            bytes32 indexed requestId,
            bytes32 secret
        );

        // Functions
        function createVault() external;
        function depositCollateral(uint256 _amount) external;
        function withdrawCollateral(uint256 _amount) external;
        function commitBurn(bytes32 requestId, bytes32 secretHash) external;
        function finalizeBurn(bytes32 requestId, bytes32 secret) external;
        function setMintReady(bytes32 requestId) external;
        function finalizeMint(bytes32 requestId, bytes32 secret) external;
        function updatePythPrices(bytes[] calldata pythUpdateData) external payable;
        
        // Structs
        struct Vault {
            address lpAddress;
            uint256 collateralAmount;
            uint256 lockedCollateral;
            uint256 normalizedDebt;
            uint256 pendingDebt;
            uint16 maxMintBps;
            uint256 mintGriefingDeposit;
            uint16 mintFeeBps;
            uint16 burnRewardBps;
            uint256 liquidationNonce;
            bool active;
        }
        
        // View functions
        function getVault(address lpAddress) external view returns (Vault memory);
    }
}

/// EVM client for interacting with the VaultManager contract
pub struct EvmClient {
    provider: alloy::providers::fillers::FillProvider<
        alloy::providers::fillers::JoinFill<
            alloy::providers::fillers::JoinFill<
                alloy::providers::Identity,
                alloy::providers::fillers::JoinFill<
                    alloy::providers::fillers::GasFiller,
                    alloy::providers::fillers::JoinFill<
                        alloy::providers::fillers::BlobGasFiller,
                        alloy::providers::fillers::JoinFill<
                            alloy::providers::fillers::NonceFiller,
                            alloy::providers::fillers::ChainIdFiller,
                        >,
                    >,
                >,
            >,
            alloy::providers::fillers::WalletFiller<EthereumWallet>,
        >,
        alloy::providers::RootProvider<alloy::pubsub::PubSubFrontend>,
        alloy::pubsub::PubSubFrontend,
        alloy::network::Ethereum,
    >,
    wallet: EthereumWallet,
    vault_manager: Address,
    lp_vault_address: Address,
    pyth_endpoint: String,
    nonce: Arc<RwLock<Option<u64>>>,
}

impl EvmClient {
    /// Create a new EVM client
    pub async fn new(
        ws_url: String,
        private_key: String,
        vault_manager: Address,
        lp_vault_address: Address,
        pyth_endpoint: String,
    ) -> Result<Self> {
        // Parse the private key
        let signer: PrivateKeySigner = private_key
            .parse()
            .context("Failed to parse private key")?;

        // Create wallet
        let wallet = EthereumWallet::from(signer);

        // Connect to WebSocket
        let ws = WsConnect::new(ws_url);
        let provider = ProviderBuilder::new()
            .with_recommended_fillers()
            .wallet(wallet.clone())
            .on_ws(ws)
            .await
            .context("Failed to connect to WebSocket")?;

        info!("Connected to EVM network");
        info!("LP Vault Address: {}", lp_vault_address);
        info!("VaultManager Address: {}", vault_manager);

        Ok(Self {
            provider,
            wallet,
            vault_manager,
            lp_vault_address,
            pyth_endpoint,
            nonce: Arc::new(RwLock::new(None)),
        })
    }

    /// Get the current nonce for the LP address
    async fn get_nonce(&self) -> Result<u64> {
        let mut nonce_lock = self.nonce.write().await;
        
        match *nonce_lock {
            Some(nonce) => {
                *nonce_lock = Some(nonce + 1);
                Ok(nonce)
            }
            None => {
                let address = self.wallet.default_signer().address();
                let nonce = self
                    .provider
                    .get_transaction_count(address)
                    .await
                    .context("Failed to get transaction count")?;
                *nonce_lock = Some(nonce + 1);
                Ok(nonce)
            }
        }
    }

    /// Reset the nonce cache
    pub async fn reset_nonce(&self) {
        let mut nonce_lock = self.nonce.write().await;
        *nonce_lock = None;
    }

    /// Fetch Pyth price update data from Hermes
    async fn fetch_pyth_update(&self) -> Result<Vec<Bytes>> {
        // Fetch price update data from Pyth Hermes API
        // This is required before any transaction that checks prices
        
        let client = reqwest::Client::new();
        let url = format!(
            "{}/latest_price_feeds?ids[]=0x46b8cc9347f04391764a0361e0b17c3ba394b001e7c304f7650f6376e37c321d&ids[]=0x31491744e2dbf6df7fcf4ac0820d18a609b49076d45066d3568424e62f686cd1",
            self.pyth_endpoint
        );

        let response = client
            .get(&url)
            .send()
            .await
            .context("Failed to fetch Pyth price update")?;

        let data: serde_json::Value = response
            .json()
            .await
            .context("Failed to parse Pyth response")?;

        // Extract VAA bytes from response
        let mut updates = Vec::new();
        if let Some(feeds) = data.as_array() {
            for feed in feeds {
                if let Some(vaa) = feed["vaa"].as_str() {
                    let vaa_bytes = hex::decode(vaa.trim_start_matches("0x"))
                        .context("Failed to decode VAA hex")?;
                    updates.push(Bytes::from(vaa_bytes));
                }
            }
        }

        if updates.is_empty() {
            warn!("No Pyth price updates found, proceeding without update");
        }

        Ok(updates)
    }

    /// Update Pyth prices on-chain before executing a transaction
    async fn update_pyth_prices(&self) -> Result<()> {
        let updates = self.fetch_pyth_update().await?;
        
        if updates.is_empty() {
            return Ok(());
        }

        info!("Updating Pyth prices with {} feeds", updates.len());

        let contract = VaultManager::new(self.vault_manager, &self.provider);
        
        // Call updatePythPrices with the VAA data
        let call = contract.updatePythPrices(updates);
        
        // Estimate gas and send transaction
        let pending_tx = call
            .send()
            .await
            .context("Failed to send updatePythPrices transaction")?;

        let receipt = pending_tx
            .get_receipt()
            .await
            .context("Failed to get updatePythPrices receipt")?;

        info!("Pyth prices updated in tx: {:?}", receipt.transaction_hash);
        Ok(())
    }

    /// Subscribe to BurnRequested events
    pub async fn subscribe_burn_requested(
        &self,
    ) -> Result<SubscriptionStream<Log>> {
        let filter = Filter::new()
            .address(self.vault_manager)
            .event_signature(VaultManager::BurnRequested::SIGNATURE_HASH)
            .from_block(0);

        let stream = self
            .provider
            .subscribe_logs(&filter)
            .await
            .context("Failed to subscribe to BurnRequested events")?;

        Ok(stream.into_stream())
    }

    /// Subscribe to MintInitiated events
    pub async fn subscribe_mint_initiated(
        &self,
    ) -> Result<SubscriptionStream<Log>> {
        let filter = Filter::new()
            .address(self.vault_manager)
            .event_signature(VaultManager::MintInitiated::SIGNATURE_HASH)
            .from_block(0);

        let stream = self
            .provider
            .subscribe_logs(&filter)
            .await
            .context("Failed to subscribe to MintInitiated events")?;

        Ok(stream.into_stream())
    }

    /// Parse a BurnRequested event
    pub fn parse_burn_requested(&self, log: &Log) -> Result<VaultManager::BurnRequested> {
        // Convert alloy RPC log to primitives log
        let prim_log = alloy::primitives::Log {
            address: log.address(),
            data: alloy::primitives::LogData::new_unchecked(
                log.topics().to_vec(),
                log.data().data.clone(),
            ),
        };
        
        let decoded = VaultManager::BurnRequested::decode_log(&prim_log, true)
            .context("Failed to decode BurnRequested event")?;
        Ok(decoded.data)
    }

    /// Parse a MintInitiated event
    pub fn parse_mint_initiated(&self, log: &Log) -> Result<VaultManager::MintInitiated> {
        // Convert alloy RPC log to primitives log
        let prim_log = alloy::primitives::Log {
            address: log.address(),
            data: alloy::primitives::LogData::new_unchecked(
                log.topics().to_vec(),
                log.data().data.clone(),
            ),
        };
        
        let decoded = VaultManager::MintInitiated::decode_log(&prim_log, true)
            .context("Failed to decode MintInitiated event")?;
        Ok(decoded.data)
    }

    /// Commit a burn by providing the secret hash
    pub async fn commit_burn(
        &self,
        request_id: FixedBytes<32>,
        secret_hash: FixedBytes<32>,
    ) -> Result<FixedBytes<32>> {
        info!(
            "Committing burn for request {} with secret_hash {}",
            hex::encode(request_id),
            hex::encode(secret_hash)
        );

        // Update Pyth prices first to prevent StalePrice errors
        self.update_pyth_prices().await?;

        let contract = VaultManager::new(self.vault_manager, &self.provider);
        
        let call = contract.commitBurn(request_id, secret_hash);
        
        let pending_tx = call
            .send()
            .await
            .context("Failed to send commitBurn transaction")?;

        let receipt = pending_tx
            .get_receipt()
            .await
            .context("Failed to get commitBurn receipt")?;

        info!("Burn committed in tx: {:?}", receipt.transaction_hash);
        Ok(receipt.transaction_hash)
    }

    /// Finalize a burn by revealing the secret
    pub async fn finalize_burn(
        &self,
        request_id: FixedBytes<32>,
        secret: FixedBytes<32>,
    ) -> Result<FixedBytes<32>> {
        info!(
            "Finalizing burn for request {} with secret {}",
            hex::encode(request_id),
            hex::encode(secret)
        );

        let contract = VaultManager::new(self.vault_manager, &self.provider);
        
        let call = contract.finalizeBurn(request_id, secret);
        
        let pending_tx = call
            .send()
            .await
            .context("Failed to send finalizeBurn transaction")?;

        let receipt = pending_tx
            .get_receipt()
            .await
            .context("Failed to get finalizeBurn receipt")?;

        info!("Burn finalized in tx: {:?}", receipt.transaction_hash);
        Ok(receipt.transaction_hash)
    }

    /// Set mint ready after verifying XMR lock
    pub async fn set_mint_ready(&self, request_id: FixedBytes<32>) -> Result<FixedBytes<32>> {
        info!("Setting mint ready for request {}", hex::encode(request_id));

        let contract = VaultManager::new(self.vault_manager, &self.provider);
        
        let call = contract.setMintReady(request_id);
        
        let pending_tx = call
            .send()
            .await
            .context("Failed to send setMintReady transaction")?;

        let receipt = pending_tx
            .get_receipt()
            .await
            .context("Failed to get setMintReady receipt")?;

        info!("Mint ready set in tx: {:?}", receipt.transaction_hash);
        Ok(receipt.transaction_hash)
    }

    /// Finalize a mint by revealing the secret
    pub async fn finalize_mint(
        &self,
        request_id: FixedBytes<32>,
        secret: FixedBytes<32>,
    ) -> Result<FixedBytes<32>> {
        info!(
            "Finalizing mint for request {} with secret {}",
            hex::encode(request_id),
            hex::encode(secret)
        );

        let contract = VaultManager::new(self.vault_manager, &self.provider);
        
        let call = contract.finalizeMint(request_id, secret);
        
        let pending_tx = call
            .send()
            .await
            .context("Failed to send finalizeMint transaction")?;

        let receipt = pending_tx
            .get_receipt()
            .await
            .context("Failed to get finalizeMint receipt")?;

        info!("Mint finalized in tx: {:?}", receipt.transaction_hash);
        Ok(receipt.transaction_hash)
    }

    /// Get vault information
    pub async fn get_vault(&self) -> Result<VaultInfo> {
        let contract = VaultManager::new(self.vault_manager, &self.provider);
        
        let vault = contract
            .getVault(self.lp_vault_address)
            .call()
            .await
            .context("Failed to call getVault")?._0;

        Ok(VaultInfo {
            lp_address: vault.lpAddress,
            collateral_amount: vault.collateralAmount,
            locked_collateral: vault.lockedCollateral,
            normalized_debt: vault.normalizedDebt,
            pending_debt: vault.pendingDebt,
            max_mint_bps: vault.maxMintBps,
            mint_griefing_deposit: vault.mintGriefingDeposit,
            mint_fee_bps: vault.mintFeeBps,
            burn_reward_bps: vault.burnRewardBps,
            liquidation_nonce: vault.liquidationNonce,
            active: vault.active,
        })
    }

    /// Get the current block number
    pub async fn get_block_number(&self) -> Result<u64> {
        self.provider
            .get_block_number()
            .await
            .context("Failed to get block number")
    }

    /// Get vault information for the LP
    pub async fn get_vault_info(&self) -> Result<VaultInfo> {
        let contract = VaultManager::new(self.vault_manager, &self.provider);
        
        let vault = contract
            .getVault(self.lp_vault_address)
            .call()
            .await
            .context("Failed to call getVault")?._0;

        Ok(VaultInfo {
            lp_address: vault.lpAddress,
            collateral_amount: vault.collateralAmount,
            locked_collateral: vault.lockedCollateral,
            normalized_debt: vault.normalizedDebt,
            pending_debt: vault.pendingDebt,
            max_mint_bps: vault.maxMintBps,
            mint_griefing_deposit: vault.mintGriefingDeposit,
            mint_fee_bps: vault.mintFeeBps,
            burn_reward_bps: vault.burnRewardBps,
            liquidation_nonce: vault.liquidationNonce,
            active: vault.active,
        })
    }

    /// Create a new LP vault
    pub async fn create_vault(&self) -> Result<FixedBytes<32>> {
        // First check if vault already exists
        let contract = VaultManager::new(self.vault_manager, &self.provider);
        
        match contract.getVault(self.lp_vault_address).call().await {
            Ok(result) if result._0.active => {
                anyhow::bail!("Vault already exists for this address. Use './lp info' to view it.");
            }
            _ => {
                // Vault doesn't exist or is inactive, proceed with creation
            }
        }
        
        // Check balance
        let balance = self.provider.get_balance(self.lp_vault_address).await
            .context("Failed to get account balance")?;
        
        if balance.is_zero() {
            anyhow::bail!("Account has no xDAI balance. Please fund your address: {}", self.lp_vault_address);
        }
        
        info!("Creating vault for address: {}", self.lp_vault_address);
        info!("Account balance: {} xDAI", balance.to::<u128>() as f64 / 1e18);
        
        let tx_builder = contract.createVault()
            .gas(500_000); // Set explicit gas limit
        
        // Send transaction with better error context
        let pending_tx = tx_builder.send().await.map_err(|e| {
            anyhow::anyhow!("Transaction failed: {}. This might be a network issue or the vault may already exist.", e)
        })?;
        
        info!("Transaction sent, waiting for confirmation...");
        
        let receipt = pending_tx.get_receipt().await
            .context("Failed to get transaction receipt")?;
        
        info!("Vault created! Transaction: {:?}", receipt.transaction_hash);
        Ok(receipt.transaction_hash)
    }

    /// Deposit collateral into vault
    pub async fn deposit_collateral(&self, amount_str: &str) -> Result<FixedBytes<32>> {
        let contract = VaultManager::new(self.vault_manager, &self.provider);
        
        // Check if vault exists
        match contract.getVault(self.lp_vault_address).call().await {
            Ok(result) if !result._0.active => {
                anyhow::bail!("Vault does not exist. Run './lp create-vault' first.");
            }
            Err(_) => {
                anyhow::bail!("Vault does not exist. Run './lp create-vault' first.");
            }
            _ => {}
        }
        
        // Parse amount (assuming it's in whole units, convert to wei/smallest unit)
        let amount: f64 = amount_str.parse().context("Invalid amount format. Use a number like '100' or '100.5'")?;
        if amount <= 0.0 {
            anyhow::bail!("Amount must be greater than 0");
        }
        
        let amount_wei = U256::from((amount * 1e18) as u128);
        
        // wxDAI address on Gnosis
        let wxdai_address = Address::from([0xe9, 0x1D, 0x15, 0x3E, 0x0b, 0x41, 0x51, 0x8A, 0x2C, 0xe8, 0xDd, 0x3D, 0x79, 0x44, 0xFa, 0x86, 0x34, 0x63, 0xa9, 0x7d]);
        let wxdai = ERC20::new(wxdai_address, &self.provider);
        
        // Check wxDAI balance
        let wxdai_balance = wxdai.balanceOf(self.lp_vault_address).call().await
            .context("Failed to check wxDAI balance")?._0;
        
        // If insufficient wxDAI, try to wrap native xDAI
        if wxdai_balance < amount_wei {
            let needed = amount_wei - wxdai_balance;
            let native_balance = self.provider.get_balance(self.lp_vault_address).await
                .context("Failed to get native xDAI balance")?;
            
            if native_balance < needed {
                let balance_dai = wxdai_balance.to::<u128>() as f64 / 1e18;
                let native_dai = native_balance.to::<u128>() as f64 / 1e18;
                anyhow::bail!(
                    "Insufficient balance. You have {:.4} wxDAI + {:.4} native xDAI = {:.4} total, but need {} wxDAI",
                    balance_dai, native_dai, balance_dai + native_dai, amount
                );
            }
            
            // Wrap the needed amount
            info!("Wrapping {:.4} native xDAI to wxDAI...", needed.to::<u128>() as f64 / 1e18);
            let weth = WETH9::new(wxdai_address, &self.provider);
            let wrap_tx = weth.deposit()
                .value(needed)
                .gas(100_000)
                .send()
                .await
                .context("Failed to wrap xDAI")?;
            
            let wrap_receipt = wrap_tx.get_receipt().await
                .context("Failed to get wrap receipt")?;
            
            info!("Wrapped xDAI to wxDAI: {:?}", wrap_receipt.transaction_hash);
        }
        
        // Check allowance
        let allowance = wxdai.allowance(self.lp_vault_address, self.vault_manager).call().await
            .context("Failed to check allowance")?._0;
        
        // Approve if needed
        if allowance < amount_wei {
            info!("Approving VaultManager to spend {} wxDAI...", amount);
            let approve_tx = wxdai.approve(self.vault_manager, amount_wei)
                .gas(100_000)
                .send()
                .await
                .context("Failed to send approval transaction")?;
            
            let approve_receipt = approve_tx.get_receipt().await
                .context("Failed to get approval receipt")?;
            
            info!("Approval confirmed: {:?}", approve_receipt.transaction_hash);
        }
        
        info!("Depositing {} wxDAI as collateral", amount);
        info!("wxDAI balance: {:.4}", wxdai_balance.to::<u128>() as f64 / 1e18);
        
        let pending_tx = contract.depositCollateral(amount_wei)
            .gas(500_000) // Set explicit gas limit
            .send()
            .await
            .map_err(|e| anyhow::anyhow!("Transaction failed: {}. Check gas and balance.", e))?;
        
        info!("Transaction sent, waiting for confirmation...");
        
        let receipt = pending_tx.get_receipt().await
            .context("Failed to get transaction receipt")?;
        
        info!("Collateral deposited! Transaction: {:?}", receipt.transaction_hash);
        Ok(receipt.transaction_hash)
    }

    /// Withdraw collateral from vault
    pub async fn withdraw_collateral(&self, amount_str: &str) -> Result<FixedBytes<32>> {
        let contract = VaultManager::new(self.vault_manager, &self.provider);
        
        // Check if vault exists
        let vault_info = self.get_vault().await?;
        if !vault_info.active {
            anyhow::bail!("Vault does not exist.");
        }
        
        // Parse amount
        let amount: f64 = amount_str.parse().context("Invalid amount format. Use a number like '100' or '100.5'")?;
        if amount <= 0.0 {
            anyhow::bail!("Amount must be greater than 0");
        }
        
        let amount_wei = U256::from((amount * 1e18) as u128);
        
        // Check available collateral (total - locked)
        let available = vault_info.collateral_amount - vault_info.locked_collateral;
        if available < amount_wei {
            let available_dai = available.to::<u128>() as f64 / 1e18;
            let locked_dai = vault_info.locked_collateral.to::<u128>() as f64 / 1e18;
            anyhow::bail!(
                "Insufficient available collateral. You have {:.4} available ({:.4} locked for burns)",
                available_dai, locked_dai
            );
        }
        
        info!("Withdrawing {} collateral...", amount);
        
        let pending_tx = contract.withdrawCollateral(amount_wei)
            .gas(500_000)
            .send()
            .await
            .map_err(|e| anyhow::anyhow!("Transaction failed: {}. Check health ratio.", e))?;
        
        info!("Transaction sent, waiting for confirmation...");
        
        let receipt = pending_tx.get_receipt().await
            .context("Failed to get transaction receipt")?;
        
        info!("Collateral withdrawn! Transaction: {:?}", receipt.transaction_hash);
        Ok(receipt.transaction_hash)
    }
}

#[derive(Debug, Clone)]
pub struct VaultInfo {
    pub lp_address: Address,
    pub collateral_amount: U256,
    pub locked_collateral: U256,
    pub normalized_debt: U256,
    pub pending_debt: U256,
    pub max_mint_bps: u16,
    pub mint_griefing_deposit: U256,
    pub mint_fee_bps: u16,
    pub burn_reward_bps: u16,
    pub liquidation_nonce: U256,
    pub active: bool,
}

impl VaultInfo {
    /// Calculate the collateralization ratio (percentage)
    /// Note: This uses normalized_debt. To get actual debt, multiply by globalDebtIndex / 1e18
    pub fn collateralization_ratio(&self, xmr_price_usd: f64, collateral_price_usd: f64) -> f64 {
        if self.normalized_debt.is_zero() {
            return f64::INFINITY;
        }

        // Convert normalized debt to USD (wsXMR has 8 decimals)
        // TODO: Should multiply by globalDebtIndex for actual debt
        let debt_usd = (self.normalized_debt.to::<u128>() as f64 / 1e8) * xmr_price_usd;

        // Convert collateral to USD (sDAI has 18 decimals)
        let collateral_usd =
            (self.collateral_amount.to::<u128>() as f64 / 1e18) * collateral_price_usd;

        (collateral_usd / debt_usd) * 100.0
    }
}
