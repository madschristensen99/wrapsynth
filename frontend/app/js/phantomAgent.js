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
        this.moneroWallet = null;    // Monero wallet instance (ephemeral or user's wallet)
        this.isInitialized = false;
        this.userWalletConnected = false; // Track if user connected their own wallet
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
        
        // Create full wallet from private spend key (derived from signature)
        // This gives us ability to sign transactions
        const wallet = await monerojs.createWalletKeys({
            privateSpendKey: this.secret.slice(2), // Remove 0x prefix
            networkType: 'stagenet', // Use stagenet for testing, mainnet for production
            language: 'English'
        });
        
        const primaryAddress = await wallet.getPrimaryAddress();
        console.log('Monero wallet initialized:', primaryAddress);
        console.log('This ephemeral wallet can sign transactions');
        
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
                // Build and broadcast Monero transaction
                // User needs to connect to a Monero daemon for this to work
                console.log(`Building transaction: ${amount} atomic units to ${destination}`);
                
                try {
                    // Create transaction using monero-javascript
                    // This requires daemon connection to get outputs and broadcast
                    const tx = await wallet.createTx({
                        accountIndex: 0,
                        address: destination,
                        amount: amount.toString(),
                        relay: true // Broadcast immediately
                    });
                    
                    return {
                        txHash: tx.getHash(),
                        success: true
                    };
                } catch (error) {
                    console.error('Transaction creation failed:', error);
                    console.error('User needs to connect to Monero daemon');
                    console.error('Set daemon URL in config or use public node');
                    throw new Error('Cannot send transaction - no daemon connection. User must configure Monero RPC endpoint.');
                }
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
            
            async claimPTLC(commitment, revealedSecret, destinationAddress) {
                // Claim PTLC by revealing secret and forward to destination
                console.log('Claiming PTLC with commitment:', commitment);
                console.log('Using revealed secret:', revealedSecret);
                console.log('Forwarding to:', destinationAddress);
                
                try {
                    // Import PTLC builder
                    const { claimPTLC } = await import('./moneroPTLC.js');
                    
                    // Claim PTLC and send directly to destination address
                    const result = await claimPTLC(
                        wallet,
                        rpc,
                        commitment,
                        revealedSecret,
                        destinationAddress
                    );
                    
                    console.log('PTLC claimed and forwarded!');
                    return result;
                } catch (error) {
                    console.error('PTLC claiming error:', error);
                    
                    // Provide helpful error messages
                    if (error.message.includes('not found')) {
                        throw new Error('PTLC not found on Monero chain - LP may not have created it yet');
                    } else if (error.message.includes('daemon')) {
                        throw new Error('Cannot connect to Monero daemon - user must configure RPC endpoint');
                    } else {
                        throw error;
                    }
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
