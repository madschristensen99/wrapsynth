use alloy::primitives::{Address, U256};
use anyhow::{Context, Result};
use std::sync::Arc;
use tracing::info;

use crate::evm::EvmClient;

pub struct LpCli {
    evm: Arc<EvmClient>,
}

impl LpCli {
    pub fn new(evm: Arc<EvmClient>) -> Self {
        Self { evm }
    }

    /// Display vault information
    pub async fn vault_info(&self) -> Result<()> {
        info!("Fetching vault information...");
        
        let vault = self.evm.get_vault_info().await?;
        
        println!("\n╔════════════════════════════════════════════════════════════╗");
        println!("║                    VAULT INFORMATION                       ║");
        println!("╠════════════════════════════════════════════════════════════╣");
        println!("║ Collateral Amount:  {:>38} ║", format_u256(vault.collateral_amount));
        println!("║ Normalized Debt:    {:>38} ║", format_u256(vault.normalized_debt));
        println!("║ Health Ratio:       {:>38} ║", calculate_health_ratio(&vault));
        println!("╚════════════════════════════════════════════════════════════╝\n");
        
        Ok(())
    }

    /// Display collateral ratio and health status
    pub async fn health_check(&self) -> Result<()> {
        info!("Checking vault health...");
        
        let vault = self.evm.get_vault_info().await?;
        let ratio = calculate_ratio(&vault);
        
        println!("\n╔════════════════════════════════════════════════════════════╗");
        println!("║                     HEALTH CHECK                           ║");
        println!("╠════════════════════════════════════════════════════════════╣");
        
        if vault.normalized_debt.is_zero() {
            println!("║ Status:             {:>38} ║", "NO DEBT");
            println!("║ Collateral Ratio:   {:>38} ║", "N/A");
        } else {
            let status = if ratio >= 150.0 {
                "✅ HEALTHY"
            } else if ratio >= 120.0 {
                "⚠️  WARNING"
            } else {
                "🚨 DANGER - LIQUIDATION RISK"
            };
            
            println!("║ Status:             {:>38} ║", status);
            println!("║ Collateral Ratio:   {:>38} ║", format!("{:.2}%", ratio));
            println!("║ Min Required:       {:>38} ║", "150.00%");
            println!("║ Liquidation At:     {:>38} ║", "120.00%");
        }
        
        println!("╚════════════════════════════════════════════════════════════╝\n");
        
        Ok(())
    }

    /// Display pending mint/burn requests
    pub async fn pending_requests(&self) -> Result<()> {
        info!("Fetching pending requests...");
        
        // TODO: Query events from the database
        println!("\n╔════════════════════════════════════════════════════════════╗");
        println!("║                   PENDING REQUESTS                         ║");
        println!("╠════════════════════════════════════════════════════════════╣");
        println!("║ No pending requests                                        ║");
        println!("╚════════════════════════════════════════════════════════════╝\n");
        
        Ok(())
    }

    /// Display recent swap history
    pub async fn history(&self, limit: usize) -> Result<()> {
        info!("Fetching swap history (last {} swaps)...", limit);
        
        // TODO: Query from database
        println!("\n╔════════════════════════════════════════════════════════════╗");
        println!("║                     SWAP HISTORY                           ║");
        println!("╠════════════════════════════════════════════════════════════╣");
        println!("║ No swap history available                                  ║");
        println!("╚════════════════════════════════════════════════════════════╝\n");
        
        Ok(())
    }

    /// Display database statistics
    pub async fn db_stats(&self, db: &crate::db::Database) -> Result<()> {
        let stats = db.stats();
        
        println!("\n╔════════════════════════════════════════════════════════════╗");
        println!("║                   DATABASE STATISTICS                      ║");
        println!("╠════════════════════════════════════════════════════════════╣");
        for line in stats.lines() {
            println!("║ {:<58} ║", line);
        }
        println!("╚════════════════════════════════════════════════════════════╝\n");
        
        Ok(())
    }

    /// Create a new LP vault (onboarding step 1)
    pub async fn create_vault(&self) -> Result<()> {
        info!("Creating new LP vault...");
        
        println!("\n╔════════════════════════════════════════════════════════════╗");
        println!("║                   CREATE LP VAULT                          ║");
        println!("╠════════════════════════════════════════════════════════════╣");
        println!("║                                                            ║");
        
        match self.evm.create_vault().await {
            Ok(tx_hash) => {
                println!("║ ✅ Vault created successfully!                            ║");
                println!("║                                                            ║");
                println!("║ Transaction: {:<42} ║", format!("{:?}", tx_hash));
                println!("║                                                            ║");
                println!("║ Next step: Deposit collateral                             ║");
                println!("║   ./lp deposit-collateral --amount <amount>               ║");
            }
            Err(e) => {
                println!("║ ❌ Failed to create vault                                  ║");
                println!("╚════════════════════════════════════════════════════════════╝");
                println!("\nFull error:");
                println!("{:#}", e);
                return Ok(());
            }
        }
        
        println!("╚════════════════════════════════════════════════════════════╝\n");
        
        Ok(())
    }

    /// Deposit collateral into vault (onboarding step 2)
    pub async fn deposit_collateral(&self, amount: &str) -> Result<()> {
        info!("Depositing collateral: {}", amount);
        
        println!("\n╔════════════════════════════════════════════════════════════╗");
        println!("║                  DEPOSIT COLLATERAL                        ║");
        println!("╠════════════════════════════════════════════════════════════╣");
        println!("║                                                            ║");
        
        match self.evm.deposit_collateral(amount).await {
            Ok(tx_hash) => {
                println!("║ ✅ Collateral deposited successfully!                     ║");
                println!("║                                                            ║");
                println!("║ Amount: {:<50} ║", amount);
                println!("║ Transaction: {:<42} ║", format!("{:?}", tx_hash));
                println!("║                                                            ║");
                println!("║ Your vault is now ready!                                  ║");
                println!("║   ./lp info    - View vault details                       ║");
                println!("║   ./lp start   - Start the LP server                      ║");
            }
            Err(e) => {
                println!("║ ❌ Failed to deposit collateral                            ║");
                println!("╚════════════════════════════════════════════════════════════╝");
                println!("\nFull error:");
                println!("{:#}", e);
                return Ok(());
            }
        }
        
        println!("╚════════════════════════════════════════════════════════════╝\n");
        
        Ok(())
    }

    /// Withdraw collateral from vault
    pub async fn withdraw_collateral(&self, amount: &str, unwrap: bool) -> Result<()> {
        info!("Withdrawing collateral: {}", amount);
        
        println!("\n╔════════════════════════════════════════════════════════════╗");
        println!("║                 WITHDRAW COLLATERAL                        ║");
        println!("╠════════════════════════════════════════════════════════════╣");
        println!("║                                                            ║");
        
        match self.evm.withdraw_collateral(amount, unwrap).await {
            Ok(tx_hash) => {
                println!("║ ✅ Collateral withdrawn successfully!                     ║");
                println!("║                                                            ║");
                println!("║ Amount: {:<50} ║", amount);
                println!("║ Transaction: {:<42} ║", format!("{:?}", tx_hash));
                println!("║                                                            ║");
                println!("║ Check your vault status with:                             ║");
                println!("║   ./lp info    - View vault details                       ║");
            }
            Err(e) => {
                println!("║ ❌ Failed to withdraw collateral                           ║");
                println!("╚════════════════════════════════════════════════════════════╝");
                println!("\nFull error:");
                println!("{:#}", e);
                return Ok(());
            }
        }
        
        println!("╚════════════════════════════════════════════════════════════╝\n");
        
        Ok(())
    }
}

fn format_u256(value: U256) -> String {
    // Assuming 18 decimals for display
    let divisor = U256::from(1_000_000_000_000_000_000u64);
    let whole = value / divisor;
    let frac = value % divisor;
    
    if frac.is_zero() {
        format!("{}", whole)
    } else {
        // Show up to 4 decimal places
        let frac_scaled = (frac * U256::from(10000u64)) / divisor;
        format!("{}.{:04}", whole, frac_scaled)
    }
}

fn calculate_ratio(vault: &crate::evm::VaultInfo) -> f64 {
    if vault.normalized_debt.is_zero() {
        return 0.0;
    }
    
    let collateral = vault.collateral_amount.to::<u128>() as f64;
    let debt = vault.normalized_debt.to::<u128>() as f64;
    
    (collateral / debt) * 100.0
}

fn calculate_health_ratio(vault: &crate::evm::VaultInfo) -> String {
    if vault.normalized_debt.is_zero() {
        "N/A (No Debt)".to_string()
    } else {
        format!("{:.2}%", calculate_ratio(vault))
    }
}
