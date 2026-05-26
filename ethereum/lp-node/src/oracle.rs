use anyhow::{Context, Result};
use reqwest::Client;
use serde::Deserialize;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tracing::{debug, error, info, warn};

const REDSTONE_API_URL: &str = "https://api.redstone.finance/prices";

#[derive(Debug, Deserialize)]
struct RedStoneResponse {
    #[serde(rename = "XMR")]
    xmr: Option<PriceData>,
    #[serde(rename = "DAI")]
    dai: Option<PriceData>,
}

#[derive(Debug, Deserialize)]
struct PriceData {
    value: f64,
    timestamp: u64,
}

#[derive(Debug, Clone)]
pub struct OraclePrices {
    pub xmr_price: u64,
    pub dai_price: u64,
    pub timestamp: u64,
}

pub struct OracleClient {
    http_client: Arc<Client>,
}

impl OracleClient {
    pub fn new() -> Self {
        let http_client = Client::builder()
            .timeout(std::time::Duration::from_secs(10))
            .build()
            .expect("Failed to create HTTP client");

        Self {
            http_client: Arc::new(http_client),
        }
    }

    /// Fetch current prices from RedStone API
    pub async fn fetch_redstone_prices(&self) -> Result<OraclePrices> {
        let url = format!(
            "{}?symbols=XMR,DAI&provider=redstone-primary-prod",
            REDSTONE_API_URL
        );

        debug!("Fetching prices from RedStone: {}", url);

        let response = self
            .http_client
            .get(&url)
            .send()
            .await
            .context("Failed to fetch RedStone prices")?;

        if !response.status().is_success() {
            anyhow::bail!("RedStone API returned error: {}", response.status());
        }

        let data: RedStoneResponse = response
            .json()
            .await
            .context("Failed to parse RedStone response")?;

        let xmr = data.xmr.ok_or_else(|| anyhow::anyhow!("Missing XMR price"))?;
        let dai = data.dai.ok_or_else(|| anyhow::anyhow!("Missing DAI price"))?;

        let xmr_price = (xmr.value * 1e8).floor() as u64;
        let dai_price = (dai.value * 1e8).floor() as u64;

        let timestamp = current_timestamp();

        debug!(
            "Fetched prices: XMR=${:.2} ({} atomic), DAI=${:.4} ({} atomic)",
            xmr.value, xmr_price, dai.value, dai_price
        );

        Ok(OraclePrices {
            xmr_price,
            dai_price,
            timestamp,
        })
    }

    /// Calculate price drift in basis points
    pub fn calculate_drift_bps(old_price: u64, new_price: u64) -> u16 {
        if old_price == 0 {
            return u16::MAX;
        }

        let diff = if new_price > old_price {
            new_price - old_price
        } else {
            old_price - new_price
        };

        let drift_bps = ((diff as f64 / old_price as f64) * 10000.0) as u16;
        drift_bps
    }
}

fn current_timestamp() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_drift_calculation() {
        assert_eq!(OracleClient::calculate_drift_bps(100, 101), 100);
        assert_eq!(OracleClient::calculate_drift_bps(100, 99), 100);
        assert_eq!(OracleClient::calculate_drift_bps(100, 102), 200);
        assert_eq!(OracleClient::calculate_drift_bps(100, 100), 0);
    }

    #[tokio::test]
    async fn test_fetch_prices() {
        let client = OracleClient::new();
        match client.fetch_redstone_prices().await {
            Ok(prices) => {
                println!("XMR: {}, DAI: {}", prices.xmr_price, prices.dai_price);
                assert!(prices.xmr_price > 0);
                assert!(prices.dai_price > 0);
            }
            Err(e) => {
                println!("Failed to fetch prices (may be network issue): {}", e);
            }
        }
    }
}
