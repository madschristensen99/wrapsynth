use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use sled::Db;
use std::sync::Arc;

/// Status of a mint operation
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum MintStatus {
    /// Waiting for user to lock XMR on Monero
    Pending,
    /// User locked XMR, waiting for confirmations
    XmrLocked,
    /// Called setMintReady on EVM
    Ready,
    /// Claimed XMR on Monero, waiting to finalize on EVM
    XmrClaimed,
    /// Finalized on EVM
    Completed,
    /// Cancelled due to timeout
    Cancelled,
}

/// Status of a burn operation
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum BurnStatus {
    /// Detected BurnRequested event
    Requested,
    /// Generated secret and committed on EVM
    Committed,
    /// XMR PTLC created on Monero
    XmrLocked,
    /// User claimed XMR, secret revealed
    SecretRevealed,
    /// Finalized on EVM
    Completed,
    /// Slashed due to timeout
    Slashed,
}

/// Mint task tracking
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MintTask {
    pub request_id: [u8; 32],
    pub user: [u8; 20],
    pub lp_vault: [u8; 20],
    pub xmr_amount: u64,
    pub wsxmr_amount: u64,
    pub claim_commitment: [u8; 32],
    pub timeout: u64,
    pub status: MintStatus,
    pub created_at: u64,
    pub updated_at: u64,
    /// The secret we generated (stored after claiming XMR)
    pub revealed_secret: Option<[u8; 32]>,
    /// Monero transaction ID where we claimed XMR
    pub monero_claim_txid: Option<String>,
}

/// Burn task tracking
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BurnTask {
    pub request_id: [u8; 32],
    pub user: [u8; 20],
    pub lp_vault: [u8; 20],
    pub wsxmr_amount: u64,
    pub xmr_amount: u64,
    pub locked_collateral: u128,
    pub deadline: u64,
    pub status: BurnStatus,
    pub created_at: u64,
    pub updated_at: u64,
    /// The secret we generate for the PTLC
    pub secret: Option<[u8; 32]>,
    /// The hash of the secret (secp256k1 point)
    pub secret_hash: Option<[u8; 32]>,
    /// Monero transaction ID where we locked XMR
    pub monero_lock_txid: Option<String>,
    /// EVM transaction hash for commitBurn
    pub commit_tx_hash: Option<[u8; 32]>,
}

/// Database wrapper for crash-safe persistence
#[derive(Clone)]
pub struct Database {
    db: Arc<Db>,
}

impl Database {
    /// Open or create the database
    pub fn open(path: &str) -> Result<Self> {
        let db = sled::open(path).context("Failed to open sled database")?;
        Ok(Self { db: Arc::new(db) })
    }

    // ========== MINT OPERATIONS ==========

    /// Insert a new mint task
    pub fn insert_mint_task(&self, task: &MintTask) -> Result<()> {
        let key = Self::mint_key(&task.request_id);
        let value = bincode::serialize(task).context("Failed to serialize mint task")?;
        self.db
            .insert(key, value)
            .context("Failed to insert mint task")?;
        self.db.flush().context("Failed to flush database")?;
        Ok(())
    }

    /// Update an existing mint task
    pub fn update_mint_task(&self, task: &MintTask) -> Result<()> {
        self.insert_mint_task(task)
    }

    /// Get a mint task by request ID
    pub fn get_mint_task(&self, request_id: &[u8; 32]) -> Result<Option<MintTask>> {
        let key = Self::mint_key(request_id);
        match self.db.get(key).context("Failed to get mint task")? {
            Some(bytes) => {
                let task = bincode::deserialize(&bytes)
                    .context("Failed to deserialize mint task")?;
                Ok(Some(task))
            }
            None => Ok(None),
        }
    }

    /// Get all mint tasks
    pub fn get_all_mint_tasks(&self) -> Result<Vec<MintTask>> {
        let prefix = b"mint:";
        let mut tasks = Vec::new();

        for result in self.db.scan_prefix(prefix) {
            let (_key, value) = result.context("Failed to scan mint tasks")?;
            let task = bincode::deserialize(&value)
                .context("Failed to deserialize mint task")?;
            tasks.push(task);
        }

        Ok(tasks)
    }

    /// Get mint tasks by status
    pub fn get_mint_tasks_by_status(&self, status: MintStatus) -> Result<Vec<MintTask>> {
        Ok(self
            .get_all_mint_tasks()?
            .into_iter()
            .filter(|t| t.status == status)
            .collect())
    }

    // ========== BURN OPERATIONS ==========

    /// Insert a new burn task
    pub fn insert_burn_task(&self, task: &BurnTask) -> Result<()> {
        let key = Self::burn_key(&task.request_id);
        let value = bincode::serialize(task).context("Failed to serialize burn task")?;
        self.db
            .insert(key, value)
            .context("Failed to insert burn task")?;
        self.db.flush().context("Failed to flush database")?;
        Ok(())
    }

    /// Update an existing burn task
    pub fn update_burn_task(&self, task: &BurnTask) -> Result<()> {
        self.insert_burn_task(task)
    }

    /// Get a burn task by request ID
    pub fn get_burn_task(&self, request_id: &[u8; 32]) -> Result<Option<BurnTask>> {
        let key = Self::burn_key(request_id);
        match self.db.get(key).context("Failed to get burn task")? {
            Some(bytes) => {
                let task = bincode::deserialize(&bytes)
                    .context("Failed to deserialize burn task")?;
                Ok(Some(task))
            }
            None => Ok(None),
        }
    }

    /// Get all burn tasks
    pub fn get_all_burn_tasks(&self) -> Result<Vec<BurnTask>> {
        let prefix = b"burn:";
        let mut tasks = Vec::new();

        for result in self.db.scan_prefix(prefix) {
            let (_key, value) = result.context("Failed to scan burn tasks")?;
            let task = bincode::deserialize(&value)
                .context("Failed to deserialize burn task")?;
            tasks.push(task);
        }

        Ok(tasks)
    }

    /// Get burn tasks by status
    pub fn get_burn_tasks_by_status(&self, status: BurnStatus) -> Result<Vec<BurnTask>> {
        Ok(self
            .get_all_burn_tasks()?
            .into_iter()
            .filter(|t| t.status == status)
            .collect())
    }

    // ========== KEY GENERATION ==========

    fn mint_key(request_id: &[u8; 32]) -> Vec<u8> {
        let mut key = b"mint:".to_vec();
        key.extend_from_slice(request_id);
        key
    }

    fn burn_key(request_id: &[u8; 32]) -> Vec<u8> {
        let mut key = b"burn:".to_vec();
        key.extend_from_slice(request_id);
        key
    }

    // ========== UTILITY ==========

    /// Flush all pending writes to disk
    pub fn flush(&self) -> Result<()> {
        self.db.flush().context("Failed to flush database")?;
        Ok(())
    }

    /// Get database statistics
    pub fn stats(&self) -> String {
        format!(
            "Database size: {} bytes, {} trees",
            self.db.size_on_disk().unwrap_or(0),
            self.db.tree_names().len()
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_mint_task_roundtrip() {
        let db = Database::open("test_db_mint").unwrap();
        
        let task = MintTask {
            request_id: [1u8; 32],
            user: [2u8; 20],
            lp_vault: [3u8; 20],
            xmr_amount: 1000000000000,
            wsxmr_amount: 100000000,
            claim_commitment: [4u8; 32],
            timeout: 1234567890,
            status: MintStatus::Pending,
            created_at: 1234567890,
            updated_at: 1234567890,
            revealed_secret: None,
            monero_claim_txid: None,
        };

        db.insert_mint_task(&task).unwrap();
        let retrieved = db.get_mint_task(&task.request_id).unwrap().unwrap();
        
        assert_eq!(retrieved.request_id, task.request_id);
        assert_eq!(retrieved.status, MintStatus::Pending);
        
        // Cleanup
        std::fs::remove_dir_all("test_db_mint").ok();
    }

    #[test]
    fn test_burn_task_roundtrip() {
        let db = Database::open("test_db_burn").unwrap();
        
        let task = BurnTask {
            request_id: [5u8; 32],
            user: [6u8; 20],
            lp_vault: [7u8; 20],
            wsxmr_amount: 100000000,
            xmr_amount: 1000000000000,
            locked_collateral: 150000000000000000,
            deadline: 1234567890,
            status: BurnStatus::Requested,
            created_at: 1234567890,
            updated_at: 1234567890,
            secret: None,
            secret_hash: None,
            monero_lock_txid: None,
            commit_tx_hash: None,
        };

        db.insert_burn_task(&task).unwrap();
        let retrieved = db.get_burn_task(&task.request_id).unwrap().unwrap();
        
        assert_eq!(retrieved.request_id, task.request_id);
        assert_eq!(retrieved.status, BurnStatus::Requested);
        
        // Cleanup
        std::fs::remove_dir_all("test_db_burn").ok();
    }
}
