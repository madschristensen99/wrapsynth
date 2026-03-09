// Phantom Agent - Deterministic Ephemeral Browser Wallet
// Derives Monero wallet from EVM signature

import { keccak256, toHex, pad, hexToBytes } from 'https://esm.sh/viem@2.7.0';
import * as secp256k1 from 'https://esm.sh/@noble/secp256k1@2.0.0';
import { getWalletClient, getUserAddress } from './viemClient.js';
import { createSwapMessage } from './config.js';

/**
 * Phantom Agent State
 */
class PhantomAgent {
    constructor() {
        this.secret = null;          // 32-byte swap secret
        this.commitment = null;      // secp256k1 public key commitment
        this.moneroWallet = null;    // WASM Monero wallet instance
        this.isInitialized = false;
    }

    /**
     * Initialize the Phantom Agent by requesting user signature
     * @param {string} action - 'MINT' or 'BURN'
     * @param {string} amount - Amount in human-readable format
     * @param {string} destination - Optional destination address for burns
     */
    async initialize(action, amount, destination = null) {
        const address = getUserAddress();
        if (!address) {
            throw new Error('Wallet not connected');
        }

        // Create deterministic message
        const message = createSwapMessage(address, action, amount, destination);
        
        console.log('Requesting signature for message:', message);

        // Request EIP-191 signature from MetaMask
        const walletClient = getWalletClient();
        const signature = await walletClient.signMessage({
            account: address,
            message
        });

        console.log('Signature received:', signature);

        // Derive 32-byte secret from signature hash
        this.secret = keccak256(signature);
        
        console.log('Derived secret:', this.secret);

        // Generate secp256k1 commitment (G * secret)
        this.commitment = await this.generateCommitment();

        console.log('Generated commitment:', this.commitment);

        // Initialize Monero wallet from secret
        await this.initializeMoneroWallet();

        this.isInitialized = true;

        return {
            secret: this.secret,
            commitment: this.commitment,
            moneroAddress: this.getMoneroAddress()
        };
    }

    /**
     * Generate secp256k1 public key commitment
     * commitment = G * secret (where G is the generator point)
     */
    async generateCommitment() {
        // Convert secret to bytes for secp256k1
        const secretBytes = hexToBytes(this.secret);
        
        // Generate public key (compressed format)
        const publicKey = secp256k1.getPublicKey(secretBytes, true);
        
        // Convert to hex and pad to 32 bytes (remove 0x04 prefix for uncompressed or use compressed)
        // For the contract, we need the 32-byte x-coordinate
        const publicKeyHex = toHex(publicKey);
        
        // For secp256k1 compressed format (33 bytes), we take the x-coordinate (32 bytes)
        // The first byte is 0x02 or 0x03 indicating y-coordinate parity
        const commitment = pad(publicKeyHex.slice(0, 66), { size: 32 });
        
        return commitment;
    }

    /**
     * Initialize Monero wallet from secret using monero-javascript
     */
    async initializeMoneroWallet() {
        console.log('Initializing Monero wallet from seed...');
        
        // Import monero-javascript dynamically
        const monerojs = await import('https://cdn.jsdelivr.net/npm/monero-javascript@0.8.4/+esm');
        
        // Convert secret (32-byte hex) to mnemonic seed
        // Monero uses 25-word mnemonic, we'll derive it from our secret
        const secretBytes = hexToBytes(this.secret);
        
        // Create wallet from private keys derived from secret
        // For browser-based wallet, we use MoneroWalletKeys (view-only capabilities)
        const wallet = await monerojs.createWalletKeys({
            privateSpendKey: this.secret.slice(2), // Remove 0x prefix
            networkType: 'stagenet', // Use stagenet for testing, mainnet for production
            language: 'English'
        });
        
        const primaryAddress = await wallet.getPrimaryAddress();
        console.log('Monero wallet initialized:', primaryAddress);
        
        // Import Monero RPC client
        const { getMoneroRpc } = await import('./moneroRpc.js');
        const rpc = getMoneroRpc();
        
        // Store wallet instance with helper methods
        this.moneroWallet = {
            wallet: wallet,
            primaryAddress: primaryAddress,
            rpc: rpc,
            
            async getBalance() {
                // Browser can check balance via RPC daemon
                // Note: This requires the daemon to have the wallet's view key
                // For privacy, users should run their own node or use trusted node
                try {
                    // This is a placeholder - actual balance checking requires wallet RPC
                    // with view key to scan outputs
                    console.warn('Balance checking requires wallet RPC with view key');
                    console.warn('For production, users should connect to their own Monero node');
                    return 0n;
                } catch (error) {
                    console.error('Error checking balance:', error);
                    return 0n;
                }
            },
            
            async sendTransaction(destination, amount) {
                // Transaction sending requires full wallet with spend key
                // This should be done by LP server, not browser
                console.error('Transaction sending must be done by LP server with full wallet');
                throw new Error('Browser cannot send transactions - LP server handles this');
            },
            
            async scanForDeposit(expectedAmount, startHeight) {
                // Scan for incoming transaction to this wallet's address
                try {
                    return await rpc.scanForDeposit(primaryAddress, expectedAmount, startHeight);
                } catch (error) {
                    console.error('Deposit scanning error:', error);
                    console.warn('Deposit scanning requires LP server with wallet RPC');
                    throw error;
                }
            },
            
            async scanForPTLC(secretHash, startHeight) {
                // Scan for PTLC transaction with matching secretHash
                try {
                    return await rpc.scanForPTLC(secretHash, startHeight);
                } catch (error) {
                    console.error('PTLC scanning error:', error);
                    console.warn('PTLC scanning requires LP server with wallet RPC');
                    throw error;
                }
            },
            
            async claimPTLC(ptlcTxHash, secret) {
                // Claim PTLC by revealing secret
                // This requires building and signing a transaction
                try {
                    return await rpc.claimPTLC(ptlcTxHash, secret);
                } catch (error) {
                    console.error('PTLC claiming error:', error);
                    console.warn('PTLC claiming requires LP server with full wallet');
                    throw error;
                }
            },
            
            async getPrivateSpendKey() {
                return await wallet.getPrivateSpendKey();
            },
            
            async getPrivateViewKey() {
                return await wallet.getPrivateViewKey();
            },
            
            async getHeight() {
                return await rpc.getHeight();
            }
        };
    }

    /**
     * Get Monero primary address
     */
    getMoneroAddress() {
        if (!this.moneroWallet) {
            throw new Error('Monero wallet not initialized');
        }
        return this.moneroWallet.primaryAddress;
    }

    /**
     * Get Monero wallet balance
     */
    async getMoneroBalance() {
        if (!this.moneroWallet) {
            throw new Error('Monero wallet not initialized');
        }
        return await this.moneroWallet.getBalance();
    }

    /**
     * Send Monero transaction
     */
    async sendMonero(destination, amount) {
        if (!this.moneroWallet) {
            throw new Error('Monero wallet not initialized');
        }
        return await this.moneroWallet.sendTransaction(destination, amount);
    }

    /**
     * Scan Monero chain for PTLC
     */
    async scanForPTLC(secretHash) {
        if (!this.moneroWallet) {
            throw new Error('Monero wallet not initialized');
        }
        return await this.moneroWallet.scanForPTLC(secretHash);
    }

    /**
     * Claim PTLC on Monero chain
     */
    async claimPTLC(ptlc) {
        if (!this.moneroWallet) {
            throw new Error('Monero wallet not initialized');
        }
        return await this.moneroWallet.claimPTLC(ptlc, this.secret);
    }

    /**
     * Get the swap secret
     */
    getSecret() {
        if (!this.secret) {
            throw new Error('Agent not initialized');
        }
        return this.secret;
    }

    /**
     * Get the commitment
     */
    getCommitment() {
        if (!this.commitment) {
            throw new Error('Agent not initialized');
        }
        return this.commitment;
    }

    /**
     * Reset the agent
     */
    reset() {
        this.secret = null;
        this.commitment = null;
        this.moneroWallet = null;
        this.isInitialized = false;
    }

    /**
     * Resume from existing secret (for recovery)
     */
    async resumeFromSecret(secret) {
        this.secret = secret;
        this.commitment = await this.generateCommitment();
        await this.initializeMoneroWallet();
        this.isInitialized = true;
        
        return {
            secret: this.secret,
            commitment: this.commitment,
            moneroAddress: this.getMoneroAddress()
        };
    }
}

// Singleton instance
let agentInstance = null;

/**
 * Get or create Phantom Agent instance
 */
export function getPhantomAgent() {
    if (!agentInstance) {
        agentInstance = new PhantomAgent();
    }
    return agentInstance;
}

/**
 * Reset Phantom Agent instance
 */
export function resetPhantomAgent() {
    if (agentInstance) {
        agentInstance.reset();
    }
    agentInstance = null;
}
