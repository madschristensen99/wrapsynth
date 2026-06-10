use crate::evm::EvmClient;
use crate::oracle::OracleClient;
use alloy::primitives::{Address, U256};
use anyhow::Result;
use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use tokio::sync::RwLock;
use tokio::time::{sleep, Duration};
use tracing::{debug, error, info, warn};

/// Uniswap V3 pool fee tier (0.3%)
const POOL_FEE: u32 = 3000;

/// 2^96 as f64
const Q96: f64 = 79228162514264337593543950336.0;

/// Minimum seconds between arbitrage trades (cooldown)
const TRADE_COOLDOWN_SECS: u64 = 60;

/// Maximum deviation before we log a warning about possible config issues
const MAX_REASONABLE_DEVIATION_BPS: u16 = 5000;

/// Arbitrage bot that keeps wsXMR price close to oracle price
pub struct ArbitrageBot {
    evm: Arc<EvmClient>,
    oracle: Arc<OracleClient>,
    pool_address: RwLock<Address>,
    wsxmr_address: Address,
    sdai_address: Address,
    swap_helper: Address,
    factory_address: Address,
    threshold_bps: u16,
    max_trade_sdai: U256,
    max_trade_wsxmr: U256,
    slippage_bps: u16,
    poll_interval_secs: u64,
    min_profit_bps: u16,
    last_trade_ts: AtomicU64,
}

/// Current pool state
#[derive(Debug, Clone)]
pub struct PoolState {
    pub sqrt_price_x96: U256,
    pub tick: i32,
    pub token0: Address,
    pub token1: Address,
    pub wsxmr_is_token0: bool,
}

/// Price comparison result
#[derive(Debug, Clone)]
pub struct PriceComparison {
    pub pool_price: f64,
    pub oracle_price: f64,
    pub deviation_bps: u16,
    pub pool_overpriced: bool,
}

impl ArbitrageBot {
    pub fn new(
        evm: Arc<EvmClient>,
        pool_address: Address,
        wsxmr_address: Address,
        sdai_address: Address,
        swap_helper: Address,
        factory_address: Address,
        threshold_bps: u16,
        max_trade_sdai: U256,
        max_trade_wsxmr: U256,
        slippage_bps: u16,
        poll_interval_secs: u64,
        min_profit_bps: u16,
    ) -> Self {
        Self {
            evm,
            oracle: Arc::new(OracleClient::new()),
            pool_address: RwLock::new(pool_address),
            wsxmr_address,
            sdai_address,
            swap_helper,
            factory_address,
            threshold_bps,
            max_trade_sdai,
            max_trade_wsxmr,
            slippage_bps,
            poll_interval_secs,
            min_profit_bps,
            last_trade_ts: AtomicU64::new(0),
        }
    }

    /// Start the arbitrage bot worker
    pub async fn start(self: Arc<Self>) -> Result<()> {
        info!(
            "Arbitrage bot started | configured_pool={} | threshold={}bps | slippage={}bps | min_profit={}bps",
            *self.pool_address.read().await, self.threshold_bps, self.slippage_bps, self.min_profit_bps
        );

        // Auto-discover pool from factory — overrides configured address if different
        match self.evm.verify_pool_address(self.factory_address, self.wsxmr_address, self.sdai_address, POOL_FEE).await {
            Ok(factory_pool) => {
                if factory_pool == Address::ZERO {
                    warn!("Factory reports no pool exists for wsXMR/sDAI + 0.3% fee!");
                } else {
                    let mut pool = self.pool_address.write().await;
                    if factory_pool != *pool {
                        info!(
                            "Auto-discovered pool from factory: {} (was configured: {})",
                            factory_pool, *pool
                        );
                        *pool = factory_pool;
                    } else {
                        info!("Pool address verified against factory: {}", factory_pool);
                    }
                }
            }
            Err(e) => {
                warn!("Could not query factory for pool: {}", e);
            }
        }

        loop {
            if let Err(e) = self.check_and_arbitrage().await {
                error!("Arbitrage cycle error: {}", e);
            }

            sleep(Duration::from_secs(self.poll_interval_secs)).await;
        }
    }

    /// Main arbitrage check-and-execute cycle
    async fn check_and_arbitrage(&self) -> Result<()> {
        if self.swap_helper == Address::ZERO {
            warn!("SwapHelper address is not configured (zero address). Skipping arbitrage.");
            return Ok(());
        }

        let pool_address = *self.pool_address.read().await;

        // 1. Fetch pool state
        let pool_state = self.evm.get_pool_state(pool_address, self.wsxmr_address).await?;
        debug!("Pool state: tick={}, sqrtPriceX96={}", pool_state.tick, pool_state.sqrt_price_x96);

        // 2. Fetch oracle prices
        let oracle_prices = self.oracle.fetch_redstone_prices().await?;
        debug!("Oracle prices: XMR={} DAI={}", oracle_prices.xmr_price, oracle_prices.dai_price);

        // 3. Compute prices and deviation
        let comparison = self.compute_price_comparison(&pool_state, &oracle_prices)?;
        info!(
            "Pool: {:.4} sDAI/wsXMR | Oracle: {:.4} sDAI/wsXMR | Deviation: {}bps | {}",
            comparison.pool_price,
            comparison.oracle_price,
            comparison.deviation_bps,
            if comparison.pool_overpriced {
                "POOL OVERPRICED"
            } else {
                "POOL UNDERPRICED"
            }
        );

        // 4. Check if deviation exceeds threshold + minimum profit
        let effective_threshold = self.threshold_bps.saturating_add(self.min_profit_bps);
        if comparison.deviation_bps <= effective_threshold {
            debug!(
                "Deviation {}bps below effective threshold {}bps, no trade",
                comparison.deviation_bps, effective_threshold
            );
            return Ok(());
        }

        // Block trades on extreme deviations — illiquid or broken pool
        if comparison.deviation_bps >= MAX_REASONABLE_DEVIATION_BPS {
            warn!(
                "Extreme deviation detected ({}bps). Skipping trade — pool may be illiquid or misconfigured.",
                comparison.deviation_bps
            );
            return Ok(());
        }

        // 5. Respect trade cooldown
        let now_secs = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        let last = self.last_trade_ts.load(Ordering::Relaxed);
        if now_secs.saturating_sub(last) < TRADE_COOLDOWN_SECS {
            debug!(
                "Trade cooldown active: {}s remaining",
                TRADE_COOLDOWN_SECS - (now_secs - last)
            );
            return Ok(());
        }

        // 6. Determine trade direction and size
        let (token_in, token_out, max_amount) = if comparison.pool_overpriced {
            // Pool overpriced: sell wsXMR for sDAI
            (self.wsxmr_address, self.sdai_address, self.max_trade_wsxmr)
        } else {
            // Pool underpriced: buy wsXMR with sDAI
            (self.sdai_address, self.wsxmr_address, self.max_trade_sdai)
        };

        // 7. Check wallet balance
        let balance = self.evm.get_token_balance(token_in).await?;
        if balance.is_zero() {
            warn!("No balance of {:?} available for arbitrage", token_in);
            return Ok(());
        }

        let trade_amount = if balance > max_amount { max_amount } else { balance };
        if trade_amount.is_zero() {
            warn!("Trade amount is zero");
            return Ok(());
        }

        info!(
            "Executing arbitrage: {:?} -> {:?} | amount={}",
            token_in, token_out, trade_amount
        );

        // 8. Approve swap helper (not router) - pool will pull via callback
        self.evm.approve_token(token_in, self.swap_helper, trade_amount).await?;

        // 9. Determine zeroForOne for direct pool swap
        let zero_for_one = if comparison.pool_overpriced {
            // Selling wsXMR: if wsxmr is token0, zeroForOne=true
            pool_state.wsxmr_is_token0
        } else {
            // Buying wsXMR: if wsxmr is token0, zeroForOne=false (sDAI->wsXMR)
            !pool_state.wsxmr_is_token0
        };

        // 10. Execute swap via SwapHelper direct pool swap
        let tx_hash = self.evm.execute_swap(
            self.swap_helper,
            pool_address,
            zero_for_one,
            trade_amount,
        ).await?;

        info!("Arbitrage swap executed: tx={:?}", tx_hash);

        // Record trade timestamp for cooldown
        let now_secs = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        self.last_trade_ts.store(now_secs, Ordering::Relaxed);

        Ok(())
    }

    /// Compute pool price vs oracle price comparison
    fn compute_price_comparison(
        &self,
        pool: &PoolState,
        oracle: &crate::oracle::OraclePrices,
    ) -> Result<PriceComparison> {
        // Pool price from sqrtPriceX96
        let sqrt_price = pool.sqrt_price_x96.to_string().parse::<f64>()
            .unwrap_or(0.0);
        if !sqrt_price.is_finite() || sqrt_price <= 0.0 {
            anyhow::bail!("Pool sqrtPriceX96 is invalid: {}", pool.sqrt_price_x96);
        }
        let price_raw = (sqrt_price / Q96).powi(2);

        // Convert to sDAI per wsXMR depending on token ordering
        // price_raw = token1/token0 in raw units
        // Human price = (token1 / 1e18) / (token0 / 1e8) = price_raw × 1e-10
        let pool_sdai_per_wsxmr = if pool.wsxmr_is_token0 {
            // token0 = wsXMR, token1 = sDAI
            // human = price_raw × 1e8/1e18 = price_raw / 1e10
            price_raw / 1e10
        } else {
            // token0 = sDAI, token1 = wsXMR
            // human = 1 / price_raw × 1e8/1e18 = 1 / (price_raw × 1e10)
            if price_raw == 0.0 {
                anyhow::bail!("Pool price_raw is zero");
            }
            1.0 / (price_raw * 1e10)
        };

        // Oracle fair price: XMR/USD divided by DAI/USD = XMR/DAI
        // Both oracle prices are in 8 decimals, so division is unitless
        if oracle.dai_price == 0 {
            anyhow::bail!("Oracle DAI price is zero");
        }
        let oracle_sdai_per_wsxmr = oracle.xmr_price as f64 / oracle.dai_price as f64;

        // Deviation
        let diff = (pool_sdai_per_wsxmr - oracle_sdai_per_wsxmr).abs();
        let deviation_bps = if oracle_sdai_per_wsxmr == 0.0 {
            0
        } else {
            ((diff / oracle_sdai_per_wsxmr) * 10000.0) as u16
        };

        let pool_overpriced = pool_sdai_per_wsxmr > oracle_sdai_per_wsxmr;

        Ok(PriceComparison {
            pool_price: pool_sdai_per_wsxmr,
            oracle_price: oracle_sdai_per_wsxmr,
            deviation_bps,
            pool_overpriced,
        })
    }

    /// Compute minimum acceptable output with slippage tolerance
    fn compute_min_output(
        &self,
        token_in: Address,
        amount_in: U256,
        comparison: &PriceComparison,
    ) -> Result<U256> {
        // For exact input, estimate expected output based on oracle price
        let expected_out = if token_in == self.wsxmr_address {
            // Selling wsXMR, expect sDAI
            let amount_in_f64 = amount_in.to_string().parse::<f64>().unwrap_or(0.0) / 1e8;
            let expected_sdai = amount_in_f64 * comparison.oracle_price;
            U256::from((expected_sdai * 1e18) as u128)
        } else {
            // Buying wsXMR with sDAI
            let amount_in_f64 = amount_in.to_string().parse::<f64>().unwrap_or(0.0) / 1e18;
            let expected_wsxmr = amount_in_f64 / comparison.oracle_price;
            U256::from((expected_wsxmr * 1e8) as u128)
        };

        // Apply slippage
        let slippage_factor = 10000u64 - self.slippage_bps as u64;
        let min_out = (expected_out * U256::from(slippage_factor)) / U256::from(10000u64);

        Ok(min_out)
    }
}
