use alloy::primitives::Address;
use alloy::signers::local::PrivateKeySigner;
use alloy::signers::Signer;
use anyhow::{Context, Result};
use rand::RngCore;
use sha2::{Digest, Sha256};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::db::{Quote, QuoteDirection};

pub struct QuoteGenerator {
    signer: PrivateKeySigner,
    lp_vault: Address,
}

impl QuoteGenerator {
    pub fn new(private_key: &str, lp_vault: Address) -> Result<Self> {
        let signer: PrivateKeySigner = private_key
            .parse()
            .context("Failed to parse private key")?;

        Ok(Self { signer, lp_vault })
    }

    /// Generate a new quote for a mint operation
    pub async fn generate_mint_quote(
        &self,
        user: Address,
        xmr_amount: u64,
        xmr_price: u64,
        fee_bps: u16,
        ttl_seconds: u64,
    ) -> Result<Quote> {
        let wsxmr_amount = self.calculate_wsxmr_amount(xmr_amount, xmr_price)?;
        let fee = (wsxmr_amount as u128 * fee_bps as u128 / 10000) as u64;
        let net_wsxmr = wsxmr_amount - fee;

        let quote_id = self.generate_quote_id();
        let created_at = current_timestamp();
        let expires_at = created_at + ttl_seconds;

        let signature = self
            .sign_quote(&quote_id, &user, xmr_amount, net_wsxmr, fee, expires_at)
            .await?;

        Ok(Quote {
            quote_id,
            direction: QuoteDirection::Mint,
            user: user.into(),
            lp_vault: self.lp_vault.into(),
            xmr_amount,
            wsxmr_amount: net_wsxmr,
            fee,
            created_at,
            expires_at,
            consumed: false,
            signature: Some(signature),
        })
    }

    /// Generate a new quote for a burn operation
    pub async fn generate_burn_quote(
        &self,
        user: Address,
        wsxmr_amount: u64,
        xmr_price: u64,
        reward_bps: u16,
        ttl_seconds: u64,
    ) -> Result<Quote> {
        let xmr_amount = self.calculate_xmr_amount(wsxmr_amount, xmr_price)?;
        let reward = (wsxmr_amount as u128 * reward_bps as u128 / 10000) as u64;

        let quote_id = self.generate_quote_id();
        let created_at = current_timestamp();
        let expires_at = created_at + ttl_seconds;

        let signature = self
            .sign_quote(&quote_id, &user, xmr_amount, wsxmr_amount, reward, expires_at)
            .await?;

        Ok(Quote {
            quote_id,
            direction: QuoteDirection::Burn,
            user: user.into(),
            lp_vault: self.lp_vault.into(),
            xmr_amount,
            wsxmr_amount,
            fee: reward,
            created_at,
            expires_at,
            consumed: false,
            signature: Some(signature),
        })
    }

    /// Calculate wsXMR amount from XMR amount and price
    fn calculate_wsxmr_amount(&self, xmr_amount: u64, _xmr_price: u64) -> Result<u64> {
        Ok(xmr_amount / 10000)
    }

    /// Calculate XMR amount from wsXMR amount and price
    fn calculate_xmr_amount(&self, wsxmr_amount: u64, _xmr_price: u64) -> Result<u64> {
        Ok(wsxmr_amount * 10000)
    }

    /// Generate a random quote ID
    fn generate_quote_id(&self) -> [u8; 32] {
        let mut quote_id = [0u8; 32];
        rand::thread_rng().fill_bytes(&mut quote_id);
        quote_id
    }

    /// Sign a quote using EIP-191
    async fn sign_quote(
        &self,
        quote_id: &[u8; 32],
        user: &Address,
        xmr_amount: u64,
        wsxmr_amount: u64,
        fee: u64,
        expires_at: u64,
    ) -> Result<Vec<u8>> {
        let mut message = Vec::new();
        message.extend_from_slice(quote_id);
        message.extend_from_slice(self.lp_vault.as_slice());
        message.extend_from_slice(user.as_slice());
        message.extend_from_slice(&xmr_amount.to_be_bytes());
        message.extend_from_slice(&wsxmr_amount.to_be_bytes());
        message.extend_from_slice(&fee.to_be_bytes());
        message.extend_from_slice(&expires_at.to_be_bytes());

        let hash = Sha256::digest(&message);

        let signature = self.signer.sign_message(&hash).await?;
        Ok(signature.as_bytes().to_vec())
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

    #[tokio::test]
    async fn test_generate_mint_quote() {
        let private_key = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
        let lp_vault = Address::ZERO;
        let user = Address::ZERO;

        let generator = QuoteGenerator::new(private_key, lp_vault).unwrap();
        let quote = generator
            .generate_mint_quote(user, 1000000000000, 39000000000, 100, 60)
            .await
            .unwrap();

        assert_eq!(quote.direction, QuoteDirection::Mint);
        assert!(quote.signature.is_some());
        assert!(quote.expires_at > quote.created_at);
    }
}
