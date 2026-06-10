use alloy::network::{EthereumWallet};
use alloy::primitives::{Address, Bytes, FixedBytes, U256};
use alloy::providers::{Provider, ProviderBuilder, WsConnect};
use alloy::pubsub::SubscriptionStream;
use alloy::rpc::types::{Filter, Log};
use alloy::signers::local::PrivateKeySigner;
use alloy::sol;
use alloy::sol_types::SolEvent;
use anyhow::{anyhow, Context, Result};
use std::sync::Arc;
use tokio::sync::RwLock;
use tracing::{debug, error, info, warn};

// Define contract ABIs using Alloy's sol! macro
sol! {
    #[sol(rpc)]
    contract ERC20 {
        function approve(address spender, uint256 amount) external returns (bool);
        function allowance(address owner, address spender) external view returns (uint256);
        function balanceOf(address account) external view returns (uint256);
    }

    #[sol(rpc)]
    contract SavingsDAI {
        function deposit(uint256 assets, address receiver) external payable returns (uint256 shares);
        function withdraw(uint256 assets, address receiver, address owner) external returns (uint256 shares);
        function previewDeposit(uint256 assets) external view returns (uint256);
        function previewWithdraw(uint256 assets) external view returns (uint256);
        function convertToShares(uint256 assets) external view returns (uint256);
        function convertToAssets(uint256 shares) external view returns (uint256);
    }

    #[sol(rpc)]
    contract WETH9 {
        function deposit() external payable;
        function withdraw(uint256 amount) external;
    }
    
    #[sol(rpc)]
    contract SimpleOracleFacet {
        function updatePrices(uint256 xmrPrice, uint256 daiPrice) external;
        function getXmrPrice() external view returns (uint256);
        function getCollateralPrice() external view returns (uint256);
        function priceUpdater() external view returns (address);
        
        event PricesUpdated(uint256 xmrPrice, uint256 daiPrice, uint256 timestamp);
    }
    
    #[sol(rpc)]
    contract UniswapV3Factory {
        function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool);
    }

    #[sol(rpc)]
    contract UniswapV3Pool {
        function slot0() external view returns (
            uint160 sqrtPriceX96,
            int24 tick,
            uint16 observationIndex,
            uint16 observationCardinality,
            uint16 observationCardinalityNext,
            uint8 feeProtocol,
            bool unlocked
        );
        function liquidity() external view returns (uint128);
        function token0() external view returns (address);
        function token1() external view returns (address);
    }

    #[sol(rpc)]
    contract SwapHelper {
        function swap(
            address pool,
            address recipient,
            bool zeroForOne,
            int256 amountSpecified,
            uint160 sqrtPriceLimitX96
        ) external returns (int256 amount0, int256 amount1);
    }

    #[sol(rpc)]
    contract VaultManager {
        // View functions
        struct MintRequest {
            bytes32 requestId;
            address initiator;
            address recipient;
            address lpVault;
            uint256 xmrAmount;
            uint256 wsxmrAmount;
            uint256 feeAmount;
            bytes32 claimCommitment;
            bytes32 userPublicKey;
            uint256 timeout;
            uint256 griefingDeposit;
            uint256 lpBond;
            uint256 normalizedDebtAmount;
            uint256 vaultMintNonce;
            uint8 status;
        }
        function mintRequests(bytes32 requestId) external view returns (MintRequest memory);
        function getMintRequest(bytes32 requestId) external view returns (MintRequest memory);

        struct BurnRequest {
            bytes32 requestId;
            address user;
            address lpVault;
            uint256 wsxmrAmount;
            uint256 xmrAmount;
            uint256 lockedCollateral;
            uint256 rewardCollateral;
            bytes32 secretHash;
            uint256 deadline;
            uint256 vaultLiquidationNonce;
            uint256 normalizedDebtAmount;
            uint8 status;
            bytes32 userClaimCommitment;
            uint256 xmrPriceAtRequest;
        }
        function burnRequests(bytes32 requestId) external view returns (BurnRequest memory);
        
        // Oracle functions
        function updateOraclePrices(bytes[] calldata updateData) external payable;
        
        // Events
        event BurnRequested(
            bytes32 indexed requestId,
            address indexed user,
            address indexed lpVault,
            uint256 wsxmrAmount,
            uint256 xmrAmount,
            uint256 rewardCollateral,
            bytes32 claimCommitment
        );

        event BurnCommitted(
            bytes32 indexed requestId,
            uint256 deadline
        );

        event BurnFinalized(
            bytes32 indexed requestId,
            bytes32 secret,
            uint256 rewardPaid
        );

        event MintInitiated(
            bytes32 indexed requestId,
            address indexed initiator,
            address indexed recipient,
            address lpVault,
            uint256 xmrAmount,
            uint256 wsxmrAmount,
            uint256 feeAmount,
            bytes32 claimCommitment,
            bytes32 userPublicKey,
            uint256 timeout
        );

        event LPKeyProvided(
            bytes32 indexed requestId,
            bytes32 lpPublicKey
        );

        event MintReady(
            bytes32 indexed requestId
        );

        event MintFinalized(
            bytes32 indexed requestId,
            bytes32 secret
        );

        // Mappings
        function lpPublicKeys(bytes32 requestId) external view returns (bytes32);
        
        // Functions
        function createVault() external;
        function depositCollateral(uint256 _amount) external;
        function provideLPKey(bytes32 _requestId, bytes32 _lpPublicSpendKey, bytes32 _lpPublicViewKey) external;
        function lpPublicViewKeys(bytes32 requestId) external view returns (bytes32);
        function withdrawCollateral(uint256 _amount) external;
        function proposeHash(bytes32 requestId, bytes32 secretHash) external;
        function finalizeBurn(bytes32 requestId, bytes32 secret) external;
        function setMintReady(bytes32 requestId) external;
        function cancelMint(bytes32 requestId) external;
        function finalizeMint(bytes32 requestId, bytes32 secret) external;
        function updatePythPrices(bytes[] calldata pythUpdateData) external payable;
        
        // Structs
        struct Vault {
            address lpAddress;
            uint256 collateralShares;
            uint256 lockedCollateral;
            uint256 normalizedDebt;
            uint256 pendingDebt;
            uint16 maxMintBps;
            uint256 mintGriefingDeposit;
            uint256 mintReadyBond;
            uint16 mintFeeBps;
            uint16 burnRewardBps;
            uint256 liquidationNonce;
            uint256 mintNonce;
            uint256 minBurnAmount;
            bool active;
            uint256 deployedSDAIShares;
            uint16 maxCoLPRangeBps;
            uint256 mintTimeoutBlocks;
            uint256 burnTimeoutBlocks;
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
    rpc_url: String,
    nonce: Arc<RwLock<Option<u64>>>,
}

impl EvmClient {
    /// Create a new EVM client
    pub async fn new(
        ws_url: String,
        rpc_url: String,
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
            rpc_url,
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
            .event_signature(VaultManager::BurnRequested::SIGNATURE_HASH);

        let stream = self
            .provider
            .subscribe_logs(&filter)
            .await
            .context("Failed to subscribe to BurnRequested events")?;

        Ok(stream.into_stream())
    }

    /// Subscribe to BurnCommitted events
    pub async fn subscribe_burn_committed(
        &self,
    ) -> Result<SubscriptionStream<Log>> {
        let filter = Filter::new()
            .address(self.vault_manager)
            .event_signature(VaultManager::BurnCommitted::SIGNATURE_HASH);

        let stream = self
            .provider
            .subscribe_logs(&filter)
            .await
            .context("Failed to subscribe to BurnCommitted events")?;

        Ok(stream.into_stream())
    }

    /// Subscribe to MintInitiated events
    pub async fn subscribe_mint_initiated(
        &self,
    ) -> Result<SubscriptionStream<Log>> {
        let filter = Filter::new()
            .address(self.vault_manager)
            .event_signature(VaultManager::MintInitiated::SIGNATURE_HASH);

        let stream = self
            .provider
            .subscribe_logs(&filter)
            .await
            .context("Failed to subscribe to MintInitiated events")?;

        Ok(stream.into_stream())
    }

    /// Query historical MintInitiated events for this LP vault
    pub async fn get_historical_mint_events(&self, from_block: u64) -> Result<Vec<Log>> {
        let filter = Filter::new()
            .address(self.vault_manager)
            .event_signature(VaultManager::MintInitiated::SIGNATURE_HASH)
            .from_block(from_block);

        let logs = self
            .provider
            .get_logs(&filter)
            .await
            .context("Failed to query historical MintInitiated events")?;

        Ok(logs)
    }

    /// Subscribe to MintFinalized events
    pub async fn subscribe_mint_finalized(
        &self,
    ) -> Result<SubscriptionStream<Log>> {
        let filter = Filter::new()
            .address(self.vault_manager)
            .event_signature(VaultManager::MintFinalized::SIGNATURE_HASH);

        let stream = self
            .provider
            .subscribe_logs(&filter)
            .await
            .context("Failed to subscribe to MintFinalized events")?;

        Ok(stream.into_stream())
    }

    /// Query historical MintFinalized events
    pub async fn get_historical_mint_finalized_events(&self, from_block: u64) -> Result<Vec<Log>> {
        let filter = Filter::new()
            .address(self.vault_manager)
            .event_signature(VaultManager::MintFinalized::SIGNATURE_HASH)
            .from_block(from_block);

        let logs = self
            .provider
            .get_logs(&filter)
            .await
            .context("Failed to query historical MintFinalized events")?;

        Ok(logs)
    }

    /// Query historical BurnRequested events for this LP vault
    pub async fn get_historical_burn_events(&self, from_block: u64) -> Result<Vec<Log>> {
        let filter = Filter::new()
            .address(self.vault_manager)
            .event_signature(VaultManager::BurnRequested::SIGNATURE_HASH)
            .from_block(from_block);

        let logs = self
            .provider
            .get_logs(&filter)
            .await
            .context("Failed to query historical BurnRequested events")?;

        Ok(logs)
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

    /// Parse a BurnCommitted event
    pub fn parse_burn_committed(&self, log: &Log) -> Result<VaultManager::BurnCommitted> {
        // Convert alloy RPC log to primitives log
        let prim_log = alloy::primitives::Log {
            address: log.address(),
            data: alloy::primitives::LogData::new_unchecked(
                log.topics().to_vec(),
                log.data().data.clone(),
            ),
        };
        
        let decoded = VaultManager::BurnCommitted::decode_log(&prim_log, true)
            .context("Failed to decode BurnCommitted event")?;
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

    /// Parse a MintFinalized event
    pub fn parse_mint_finalized(&self, log: &Log) -> Result<VaultManager::MintFinalized> {
        let prim_log = alloy::primitives::Log {
            address: log.address(),
            data: alloy::primitives::LogData::new_unchecked(
                log.topics().to_vec(),
                log.data().data.clone(),
            ),
        };
        
        let decoded = VaultManager::MintFinalized::decode_log(&prim_log, true)
            .context("Failed to decode MintFinalized event")?;
        Ok(decoded.data)
    }

    /// Propose hash for a burn by providing the secret hash
    pub async fn propose_hash(
        &self,
        request_id: FixedBytes<32>,
        secret_hash: FixedBytes<32>,
    ) -> Result<FixedBytes<32>> {
        info!(
            "Proposing hash for burn request {} with secret_hash {}",
            hex::encode(request_id),
            hex::encode(secret_hash)
        );

        let contract = VaultManager::new(self.vault_manager, &self.provider);
        
        let call = contract.proposeHash(request_id, secret_hash);
        
        let pending_tx = call
            .send()
            .await
            .map_err(|e| {
                error!("proposeHash send failed: {:?}", e);
                anyhow::anyhow!("Failed to send proposeHash transaction: {:?}", e)
            })?;

        let receipt = pending_tx
            .get_receipt()
            .await
            .map_err(|e| {
                error!("proposeHash receipt failed: {:?}", e);
                anyhow::anyhow!("Failed to get proposeHash receipt: {:?}", e)
            })?;

        info!("Hash proposed in tx: {:?}", receipt.transaction_hash);
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

    /// Get LP public key for a request (returns zero bytes if not set)
    pub async fn get_lp_public_key(&self, request_id: FixedBytes<32>) -> Result<FixedBytes<32>> {
        let contract = VaultManager::new(self.vault_manager, &self.provider);
        let key = contract.lpPublicKeys(request_id).call().await?;
        Ok(key._0)
    }

    /// Get mint request status (0=INVALID, 1=PENDING, 2=KEY_PROVIDED, 3=READY, 4=COMPLETED, 5=CANCELLED)
    pub async fn get_mint_request_status(&self, request_id: FixedBytes<32>) -> Result<u8> {
        let contract = VaultManager::new(self.vault_manager, &self.provider);
        let request = contract.mintRequests(request_id).call().await?;
        Ok(request._0.status)
    }

    /// Provide LP's public keys (spend and view) for Farcaster atomic swap
    pub async fn provide_lp_key(&self, request_id: FixedBytes<32>, lp_public_spend_key: FixedBytes<32>, lp_public_view_key: FixedBytes<32>) -> Result<FixedBytes<32>> {
        info!("Providing LP keys for request {}", hex::encode(request_id));

        let http_url: reqwest::Url = self.rpc_url.parse()
            .context("Invalid HTTP RPC URL")?;

        let max_retries = 3;
        let mut last_error = None;

        for attempt in 1..=max_retries {
            let http_provider = ProviderBuilder::new()
                .with_recommended_fillers()
                .wallet(self.wallet.clone())
                .on_http(http_url.clone());

            let contract = VaultManager::new(self.vault_manager, &http_provider);

            let call = contract.provideLPKey(request_id, lp_public_spend_key, lp_public_view_key)
                .from(self.lp_vault_address);

            let pending_tx = match tokio::time::timeout(
                std::time::Duration::from_secs(30),
                call.send()
            ).await {
                Ok(Ok(tx)) => tx,
                Ok(Err(e)) => {
                    error!("Failed to send provideLPKey transaction (attempt {}/{}): {:?}", attempt, max_retries, e);
                    last_error = Some(anyhow!("Failed to send provideLPKey transaction: {}", e));
                    if attempt < max_retries {
                        tokio::time::sleep(std::time::Duration::from_secs(3)).await;
                        continue;
                    }
                    return Err(last_error.unwrap());
                }
                Err(_) => {
                    error!("Timeout sending provideLPKey transaction after 30s (attempt {}/{})", attempt, max_retries);
                    last_error = Some(anyhow!("Timeout sending provideLPKey transaction"));
                    if attempt < max_retries {
                        tokio::time::sleep(std::time::Duration::from_secs(3)).await;
                        continue;
                    }
                    return Err(last_error.unwrap());
                }
            };

            info!("provideLPKey transaction sent, waiting for receipt...");

            let receipt = match tokio::time::timeout(
                std::time::Duration::from_secs(60),
                pending_tx.get_receipt()
            ).await {
                Ok(Ok(r)) => r,
                Ok(Err(e)) => {
                    return Err(anyhow!("Failed to get provideLPKey receipt: {}", e));
                }
                Err(_) => {
                    return Err(anyhow!("Timeout waiting for provideLPKey receipt after 60s"));
                }
            };

            if !receipt.inner.status() {
                return Err(anyhow!("provideLPKey transaction reverted in tx: {:?}", receipt.transaction_hash));
            }

            info!("LP key provided in tx: {:?}", receipt.transaction_hash);
            return Ok(receipt.transaction_hash);
        }

        Err(last_error.unwrap_or_else(|| anyhow!("provideLPKey failed after {} attempts", max_retries)))
    }

    /// Get mint request from on-chain
    pub async fn get_mint_request(&self, request_id: FixedBytes<32>) -> Result<VaultManager::MintRequest> {
        let contract = VaultManager::new(self.vault_manager, &self.provider);
        let request = contract.getMintRequest(request_id).call().await
            .map_err(|e| anyhow!("Failed to query mint request: {}", e))?;
        Ok(request._0)
    }

    /// Get burn request from on-chain
    pub async fn get_burn_request(&self, request_id: FixedBytes<32>) -> Result<VaultManager::BurnRequest> {
        let contract = VaultManager::new(self.vault_manager, &self.provider);
        let request = contract.burnRequests(request_id).call().await
            .map_err(|e| anyhow!("Failed to query burn request: {}", e))?;
        Ok(request._0)
    }

    /// Cancel an expired mint
    pub async fn cancel_mint(&self, request_id: FixedBytes<32>) -> Result<FixedBytes<32>> {
        info!("Cancelling mint for request {}", hex::encode(request_id));

        let contract = VaultManager::new(self.vault_manager, &self.provider);
        
        let call = contract.cancelMint(request_id);
        
        let pending_tx = call
            .send()
            .await
            .map_err(|e| {
                error!("Failed to send cancelMint transaction: {:?}", e);
                anyhow!("Failed to send cancelMint transaction: {}", e)
            })?;

        let receipt = pending_tx
            .get_receipt()
            .await
            .map_err(|e| {
                error!("Failed to get cancelMint receipt: {:?}", e);
                anyhow!("Failed to get cancelMint receipt: {}", e)
            })?;

        info!("Mint cancelled in tx: {:?}", receipt.transaction_hash);
        Ok(receipt.transaction_hash)
    }

    /// Set mint ready after verifying XMR lock
    pub async fn set_mint_ready(&self, request_id: FixedBytes<32>) -> Result<FixedBytes<32>> {
        info!("Setting mint ready for request {}", hex::encode(request_id));

        let http_url: reqwest::Url = self.rpc_url.parse()
            .context("Invalid HTTP RPC URL")?;
        let http_provider = ProviderBuilder::new()
            .with_recommended_fillers()
            .wallet(self.wallet.clone())
            .on_http(http_url);

        let contract = VaultManager::new(self.vault_manager, &http_provider);

        // Set the bond value (0.001 xDAI = 1000000000000000 wei)
        // TODO: Query this from the vault instead of hardcoding
        let bond_value = alloy::primitives::U256::from(1000000000000000u64);

        let call = contract.setMintReady(request_id)
            .from(self.lp_vault_address)
            .value(bond_value);

        let pending_tx = match tokio::time::timeout(
            std::time::Duration::from_secs(30),
            call.send()
        ).await {
            Ok(Ok(tx)) => tx,
            Ok(Err(e)) => {
                error!("Failed to send setMintReady transaction: {:?}", e);
                return Err(anyhow!("Failed to send setMintReady transaction: {}", e));
            }
            Err(_) => {
                error!("Timeout sending setMintReady transaction after 30s");
                return Err(anyhow!("Timeout sending setMintReady transaction"));
            }
        };

        let receipt = match tokio::time::timeout(
            std::time::Duration::from_secs(60),
            pending_tx.get_receipt()
        ).await {
            Ok(Ok(r)) => r,
            Ok(Err(e)) => {
                return Err(anyhow!("Failed to get setMintReady receipt: {}", e));
            }
            Err(_) => {
                return Err(anyhow!("Timeout waiting for setMintReady receipt after 60s"));
            }
        };

        if !receipt.inner.status() {
            return Err(anyhow!("setMintReady transaction reverted in tx: {:?}", receipt.transaction_hash));
        }

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
            collateral_shares: vault.collateralShares,
            locked_collateral: vault.lockedCollateral,
            normalized_debt: vault.normalizedDebt,
            pending_debt: vault.pendingDebt,
            max_mint_bps: vault.maxMintBps,
            mint_griefing_deposit: vault.mintGriefingDeposit,
            mint_ready_bond: vault.mintReadyBond,
            mint_fee_bps: vault.mintFeeBps,
            burn_reward_bps: vault.burnRewardBps,
            liquidation_nonce: vault.liquidationNonce,
            active: vault.active,
            deployed_sdai_shares: vault.deployedSDAIShares,
            max_colp_range_bps: vault.maxCoLPRangeBps,
            mint_timeout_blocks: vault.mintTimeoutBlocks,
            burn_timeout_blocks: vault.burnTimeoutBlocks,
        })
    }

    /// Get the current block number
    pub async fn get_block_number(&self) -> Result<u64> {
        self.provider
            .get_block_number()
            .await
            .context("Failed to get block number")
    }

        // ========== ARBITRAGE / POOL METHODS ==========

    /// Get current pool state (tick, sqrtPriceX96, token ordering)
    pub async fn get_pool_state(&self, pool_address: Address, wsxmr_address: Address) -> Result<crate::arbitrage::PoolState> {
        let pool = UniswapV3Pool::new(pool_address, &self.provider);

        let slot0 = pool.slot0().call().await
            .context("Failed to query pool slot0")?;

        let token0 = pool.token0().call().await
            .context("Failed to query pool token0")?._0;

        let wsxmr_is_token0 = token0 == wsxmr_address;

        Ok(crate::arbitrage::PoolState {
            sqrt_price_x96: {
                let bytes = slot0.sqrtPriceX96.to_be_bytes::<20>();
                let mut padded = [0u8; 32];
                padded[12..32].copy_from_slice(&bytes);
                U256::from_be_bytes(padded)
            },
            tick: {
                let raw: u32 = slot0.tick.bits();
                ((raw << 8) as i32) >> 8
            },
            token0,
            token1: pool.token1().call().await.context("Failed to query pool token1")?._0,
            wsxmr_is_token0,
        })
    }

    /// Get native xDAI balance of the wallet
    pub async fn get_xdai_balance(&self) -> Result<U256> {
        let address = self.wallet.default_signer().address();
        let balance = self.provider.get_balance(address).await
            .context("Failed to get xDAI balance")?;
        Ok(balance)
    }

    /// Wrap xDAI into sDAI via SavingsDAI deposit
    pub async fn wrap_xdai_to_sdai(&self, sdai_address: Address, amount: U256) -> Result<FixedBytes<32>> {
        let sdai = SavingsDAI::new(sdai_address, &self.provider);
        let recipient = self.wallet.default_signer().address();

        info!("Wrapping {} xDAI into sDAI for {}", amount, recipient);

        // Deposit xDAI (sent as msg.value) to get sDAI shares
        let call = sdai.deposit(amount, recipient);
        let pending_tx = call.value(amount).send().await
            .context("Failed to send sDAI deposit transaction")?;

        let receipt = pending_tx.get_receipt().await
            .context("Failed to get sDAI deposit receipt")?;

        info!("xDAI wrapped to sDAI: {:?}", receipt.transaction_hash);
        Ok(receipt.transaction_hash)
    }

    /// Verify a pool address against the Uniswap V3 factory
    pub async fn verify_pool_address(&self, factory_address: Address, token_a: Address, token_b: Address, fee: u32) -> Result<Address> {
        let factory = UniswapV3Factory::new(factory_address, &self.provider);
        let fee_uint = alloy::primitives::Uint::<24, 1>::from(fee as u64);
        let pool = factory.getPool(token_a, token_b, fee_uint).call().await
            .context("Failed to query factory for pool")?.pool;
        Ok(pool)
    }

    /// Get ERC20 token balance for the wallet address
    pub async fn get_token_balance(&self, token: Address) -> Result<U256> {
        let erc20 = ERC20::new(token, &self.provider);
        let address = self.wallet.default_signer().address();
        let balance = erc20.balanceOf(address).call().await
            .context("Failed to query token balance")?._0;
        Ok(balance)
    }

    /// Approve a token spender
    pub async fn approve_token(&self, token: Address, spender: Address, amount: U256) -> Result<FixedBytes<32>> {
        let erc20 = ERC20::new(token, &self.provider);

        // Check current allowance first
        let owner = self.wallet.default_signer().address();
        let current_allowance = erc20.allowance(owner, spender).call().await
            .context("Failed to query allowance")?._0;

        if current_allowance >= amount {
            debug!("Allowance already sufficient for {:?}", token);
            // Return zero hash as no tx needed
            return Ok(FixedBytes::from_slice(&[0u8; 32]));
        }

        info!("Approving {:?} for spender {:?} amount {}", token, spender, amount);

        let call = erc20.approve(spender, amount);
        let pending_tx = call.send().await
            .context("Failed to send approve transaction")?;

        let receipt = pending_tx.get_receipt().await
            .context("Failed to get approve receipt")?;

        info!("Approval confirmed: {:?}", receipt.transaction_hash);
        Ok(receipt.transaction_hash)
    }

    /// Execute a swap via SwapHelper direct pool swap (like testPoolSwaps.js)
    pub async fn execute_swap(
        &self,
        swap_helper: Address,
        pool_address: Address,
        zero_for_one: bool,
        amount_in: U256,
    ) -> Result<FixedBytes<32>> {
        let helper = SwapHelper::new(swap_helper, &self.provider);
        let recipient = self.wallet.default_signer().address();

        // Convert amount to signed int256 (positive = exact input)
        let amount_specified = alloy::primitives::I256::from_raw(amount_in);

        info!(
            "Executing swap via helper: pool={} zeroForOne={} amount={}",
            pool_address, zero_for_one, amount_in
        );

        let call = helper.swap(
            pool_address,
            recipient,
            zero_for_one,
            amount_specified,
            alloy::primitives::U160::ZERO,
        );
        let pending_tx = call.send().await
            .context("Failed to send swap transaction")?;

        let receipt = pending_tx.get_receipt().await
            .context("Failed to get swap receipt")?;

        info!("Swap executed: {:?}", receipt.transaction_hash);
        Ok(receipt.transaction_hash)
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
            collateral_shares: vault.collateralShares,
            locked_collateral: vault.lockedCollateral,
            normalized_debt: vault.normalizedDebt,
            pending_debt: vault.pendingDebt,
            max_mint_bps: vault.maxMintBps,
            mint_griefing_deposit: vault.mintGriefingDeposit,
            mint_ready_bond: vault.mintReadyBond,
            mint_fee_bps: vault.mintFeeBps,
            burn_reward_bps: vault.burnRewardBps,
            liquidation_nonce: vault.liquidationNonce,
            active: vault.active,
            deployed_sdai_shares: vault.deployedSDAIShares,
            max_colp_range_bps: vault.maxCoLPRangeBps,
            mint_timeout_blocks: vault.mintTimeoutBlocks,
            burn_timeout_blocks: vault.burnTimeoutBlocks,
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
    pub async fn withdraw_collateral(&self, amount_str: &str, unwrap_to_native: bool) -> Result<FixedBytes<32>> {
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
        let available = vault_info.collateral_shares - vault_info.locked_collateral;
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
        
        // Optionally unwrap wxDAI to native xDAI
        if unwrap_to_native {
            info!("Unwrapping wxDAI to native xDAI...");
            let wxdai_address = Address::from([0xe9, 0x1D, 0x15, 0x3E, 0x0b, 0x41, 0x51, 0x8A, 0x2C, 0xe8, 0xDd, 0x3D, 0x79, 0x44, 0xFa, 0x86, 0x34, 0x63, 0xa9, 0x7d]);
            let wxdai = ERC20::new(wxdai_address, &self.provider);
            
            // Check wxDAI balance to unwrap
            let wxdai_balance = wxdai.balanceOf(self.lp_vault_address).call().await
                .context("Failed to check wxDAI balance")?._0;
            
            if wxdai_balance > U256::ZERO {
                let weth = WETH9::new(wxdai_address, &self.provider);
                let unwrap_tx = weth.withdraw(wxdai_balance)
                    .gas(100_000)
                    .send()
                    .await
                    .context("Failed to unwrap wxDAI")?;
                
                let unwrap_receipt = unwrap_tx.get_receipt().await
                    .context("Failed to get unwrap receipt")?;
                
                info!("Unwrapped wxDAI to native xDAI: {:?}", unwrap_receipt.transaction_hash);
            }
        }
        
        Ok(receipt.transaction_hash)
    }

    /// Get the current status of a mint request
    pub async fn get_mint_status(&self, request_id: FixedBytes<32>) -> Result<u8> {
        let contract = VaultManager::new(self.vault_manager, &self.provider);
        let mint_request = match tokio::time::timeout(
            std::time::Duration::from_secs(10),
            contract.getMintRequest(request_id).call()
        ).await {
            Ok(Ok(r)) => r,
            Ok(Err(e)) => return Err(anyhow!("Failed to query mint request: {}", e)),
            Err(_) => return Err(anyhow!("Timeout querying mint request status")),
        };
        Ok(mint_request._0.status)
    }

    /// Get the current status of a burn request
    pub async fn get_burn_status(&self, request_id: FixedBytes<32>) -> Result<u8> {
        let contract = VaultManager::new(self.vault_manager, &self.provider);
        let burn_request = contract.burnRequests(request_id).call().await?;
        Ok(burn_request._0.status)
    }

    /// Update oracle prices using RedStone signed data packages
    pub async fn update_oracle_prices_redstone(&self, redstone_data: Vec<u8>) -> Result<FixedBytes<32>> {
        info!("Updating oracle prices via RedStone ({} bytes of signed data)", redstone_data.len());

        let contract = VaultManager::new(self.vault_manager, &self.provider);
        
        // Convert RedStone data to bytes array for the contract call
        // RedStone data should be appended to calldata, but for now we pass it as parameter
        // TODO: Properly append to calldata instead of passing as parameter
        let data_bytes = alloy::primitives::Bytes::from(redstone_data);
        let update_data: Vec<alloy::primitives::Bytes> = vec![data_bytes];
        
        let call = contract.updateOraclePrices(update_data);
        
        let pending_tx = call
            .send()
            .await
            .context("Failed to send updateOraclePrices transaction")?;

        let receipt = pending_tx
            .get_receipt()
            .await
            .context("Failed to get updateOraclePrices receipt")?;

        info!("Oracle prices updated in tx: {:?}", receipt.transaction_hash);
        Ok(receipt.transaction_hash)
    }

    /// Get last oracle state (price and timestamp)
    pub async fn get_last_oracle_state(&self) -> Result<(u64, u64)> {
        let contract = SimpleOracleFacet::new(self.vault_manager, &self.provider);
        
        let xmr_price = contract.getXmrPrice().call().await
            .context("Failed to get XMR price")?._0;
        
        let current_block = self.provider.get_block_number().await
            .context("Failed to get block number")?;
        let block = self.provider.get_block_by_number(current_block.into(), false.into()).await
            .context("Failed to get block")?
            .ok_or_else(|| anyhow::anyhow!("Block not found"))?;
        
        let timestamp = block.header.timestamp;
        let xmr_price_u64 = (xmr_price / U256::from(10u64.pow(10))).to::<u64>();
        
        Ok((xmr_price_u64, timestamp))
    }

    /// Calculate LP capacity in XMR atomic units
    pub async fn get_lp_capacity(&self, active_quote_holds: u64) -> Result<u64> {
        let vault = self.get_vault().await?;
        
        let collateral_price = SimpleOracleFacet::new(self.vault_manager, &self.provider)
            .getCollateralPrice()
            .call()
            .await
            .context("Failed to get collateral price")?._0;
        
        let xmr_price = SimpleOracleFacet::new(self.vault_manager, &self.provider)
            .getXmrPrice()
            .call()
            .await
            .context("Failed to get XMR price")?._0;
        
        let available_collateral = vault.collateral_shares.saturating_sub(vault.locked_collateral);
        
        let available_collateral_usd = (available_collateral * collateral_price) / U256::from(10u64.pow(18));
        
        let max_debt_usd = (available_collateral_usd * U256::from(100)) / U256::from(150);
        
        let current_debt_usd = ((vault.normalized_debt + vault.pending_debt) * xmr_price) / U256::from(10u64.pow(8));
        
        let capacity_usd = max_debt_usd.saturating_sub(current_debt_usd);
        
        let capacity_xmr = if xmr_price.is_zero() {
            0
        } else {
            ((capacity_usd * U256::from(10u64.pow(8))) / xmr_price).to::<u64>()
        };
        
        let capacity_after_holds = capacity_xmr.saturating_sub(active_quote_holds);
        
        Ok(capacity_after_holds)
    }

    /// Verify a mint event exists in a transaction
    pub async fn verify_mint_event_in_tx(&self, tx_hash: FixedBytes<32>, expected_request_id: [u8; 32]) -> Result<bool> {
        let receipt = self.provider.get_transaction_receipt(tx_hash)
            .await
            .context("Failed to get transaction receipt")?
            .ok_or_else(|| anyhow::anyhow!("Transaction not found"))?;
        
        for log in receipt.inner.logs() {
            if log.address() == self.vault_manager {
                if let Ok(event) = self.parse_mint_initiated(log) {
                    let event_request_id: [u8; 32] = event.requestId.into();
                    if event_request_id == expected_request_id {
                        return Ok(true);
                    }
                }
            }
        }
        
        Ok(false)
    }
}

#[derive(Debug, Clone)]
pub struct VaultInfo {
    pub lp_address: Address,
    pub collateral_shares: U256,
    pub locked_collateral: U256,
    pub normalized_debt: U256,
    pub pending_debt: U256,
    pub max_mint_bps: u16,
    pub mint_griefing_deposit: U256,
    pub mint_ready_bond: U256,
    pub mint_fee_bps: u16,
    pub burn_reward_bps: u16,
    pub liquidation_nonce: U256,
    pub active: bool,
    pub deployed_sdai_shares: U256,
    pub max_colp_range_bps: u16,
    pub mint_timeout_blocks: U256,
    pub burn_timeout_blocks: U256,
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
            (self.collateral_shares.to::<u128>() as f64 / 1e18) * collateral_price_usd;

        (collateral_usd / debt_usd) * 100.0
    }
}
