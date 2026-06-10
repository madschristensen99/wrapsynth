// Monero RPC Client
// Handles all Monero daemon and wallet RPC interactions

import { MONERO_CONFIG } from './config.js';

/**
 * Monero RPC Client for daemon and wallet operations
 */
class MoneroRpcClient {
    constructor(rpcUrl = MONERO_CONFIG.rpcUrl) {
        this.rpcUrl = rpcUrl;
        this.walletRpcUrl = null; // Set when wallet RPC is available
    }

    /**
     * Make RPC call to Monero daemon
     */
    async daemonRpc(method, params = {}) {
        try {
            const response = await fetch(this.rpcUrl + '/json_rpc', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    id: '0',
                    method: method,
                    params: params
                })
            });

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const data = await response.json();
            
            if (data.error) {
                throw new Error(`RPC error: ${data.error.message}`);
            }

            return data.result;
        } catch (error) {
            console.error(`Monero RPC error (${method}):`, error);
            throw error;
        }
    }

    /**
     * Get current blockchain height
     */
    async getHeight() {
        const result = await this.daemonRpc('get_block_count');
        return result.count;
    }

    /**
     * Get block by height
     */
    async getBlock(height) {
        const result = await this.daemonRpc('get_block', { height });
        return result;
    }

    /**
     * Get transaction by hash
     */
    async getTransaction(txHash) {
        try {
            const response = await fetch(this.rpcUrl + '/get_transactions', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    txs_hashes: [txHash],
                    decode_as_json: true
                })
            });

            const data = await response.json();
            
            if (data.status !== 'OK') {
                throw new Error(`Failed to get transaction: ${data.status}`);
            }

            return data.txs && data.txs.length > 0 ? data.txs[0] : null;
        } catch (error) {
            console.error('Error getting transaction:', error);
            throw error;
        }
    }

    /**
     * Scan for transactions to a specific address
     * This is a simplified version - full implementation requires wallet RPC
     */
    async scanForDeposit(address, expectedAmount, startHeight = null) {
        console.log(`Scanning for deposit to ${address} of ${expectedAmount} atomic units`);
        
        // Get current height
        const currentHeight = await this.getHeight();
        const scanStart = startHeight || (currentHeight - 100); // Scan last 100 blocks by default

        console.log(`Scanning blocks ${scanStart} to ${currentHeight}`);

        // Note: This is a simplified scan. Full implementation requires:
        // 1. Wallet RPC with view key to decrypt outputs
        // 2. Checking each transaction output in each block
        // 3. Verifying the output belongs to the target address
        
        // For production, this should be done by the LP server with full wallet access
        throw new Error('Deposit scanning requires wallet RPC - must be done by LP server');
    }

    /**
     * Verify a transaction exists on the blockchain and get its confirmation count
     */
    async verifyTransaction(txHash) {
        const tx = await this.getTransaction(txHash);
        if (!tx) {
            return { found: false, error: 'Transaction not found on blockchain' };
        }

        const blockHeight = tx.block_height;
        if (tx.in_pool || !blockHeight) {
            return { found: true, txHash, confirmations: 0, inPool: true };
        }

        const currentHeight = await this.getHeight();
        const confirmations = Math.max(0, currentHeight - blockHeight + 1);

        return {
            found: true,
            txHash,
            blockHeight,
            confirmations,
            inPool: false
        };
    }

    /**
     * Create a PTLC (Point Time Locked Contract) transaction
     * This requires custom Monero transaction building
     */
    async createPTLC(params) {
        const { 
            amount,           // Amount in atomic units
            recipientAddress, // Recipient's Monero address
            secretHash,       // Ed25519 commitment (keccak256 hash of public key)
            lockTime          // Timelock in blocks
        } = params;

        console.log('Creating PTLC transaction:', params);

        // PTLC creation requires:
        // 1. Custom transaction builder (not standard Monero)
        // 2. Adding extra field for secretHash verification
        // 3. Setting timelock for refund path
        // 4. Signing with sender's keys
        
        // This MUST be done by the LP server with full wallet access
        throw new Error('PTLC creation requires full wallet - must be done by LP server');
    }

    /**
     * Scan blockchain for PTLC with specific secretHash
     */
    async scanForPTLC(secretHash, startHeight = null) {
        console.log(`Scanning for PTLC with secretHash: ${secretHash}`);

        // Get current height
        const currentHeight = await this.getHeight();
        const scanStart = startHeight || (currentHeight - 100);

        console.log(`Scanning blocks ${scanStart} to ${currentHeight}`);

        // PTLC scanning requires:
        // 1. Wallet RPC to decrypt transaction extra fields
        // 2. Custom parsing of PTLC transaction format
        // 3. Verification that secretHash matches
        
        // For production, this should be done by the LP server
        throw new Error('PTLC scanning requires wallet RPC - must be done by LP server');
    }

    /**
     * Claim a PTLC by revealing the secret
     */
    async claimPTLC(ptlcTxHash, secret) {
        console.log(`Claiming PTLC ${ptlcTxHash} with secret`);

        // PTLC claiming requires:
        // 1. Building a transaction that spends the PTLC output
        // 2. Including the secret in the transaction
        // 3. Signing with recipient's keys
        
        // This MUST be done by the LP server or user's full wallet
        throw new Error('PTLC claiming requires full wallet - must be done by LP server');
    }

    /**
     * Check if a Monero address is valid
     */
    isValidAddress(address) {
        // Monero addresses are base58 encoded and have specific prefixes:
        // Mainnet: starts with 4
        // Testnet: starts with 9 or A
        // Stagenet: starts with 5
        
        if (!address || typeof address !== 'string') {
            return false;
        }

        // Basic validation
        if (address.length < 95 || address.length > 106) {
            return false;
        }

        // Check prefix
        const validPrefixes = ['4', '5', '9', 'A', 'B']; // Mainnet, Stagenet, Testnet
        if (!validPrefixes.includes(address[0])) {
            return false;
        }

        return true;
    }

    /**
     * Convert XMR to atomic units (piconero)
     */
    xmrToAtomic(xmr) {
        return BigInt(Math.floor(xmr * 1e12));
    }

    /**
     * Convert atomic units to XMR
     */
    atomicToXmr(atomic) {
        return Number(atomic) / 1e12;
    }
}

// Singleton instance
let rpcInstance = null;

/**
 * Get Monero RPC client instance
 */
export function getMoneroRpc() {
    if (!rpcInstance) {
        rpcInstance = new MoneroRpcClient();
    }
    return rpcInstance;
}

/**
 * Set custom RPC URL (for testing or custom nodes)
 */
export function setMoneroRpcUrl(url) {
    rpcInstance = new MoneroRpcClient(url);
}
