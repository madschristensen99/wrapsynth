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
     * Initialize Monero wallet interface (browser-compatible)
     * Note: Actual Monero operations are handled by the LP server
     * The browser only needs to display info and track state
     */
    async initializeMoneroWallet() {
        console.log('Initializing Monero wallet interface...');
        
        // For browser-based minting, we don't need full Monero wallet
        // The LP server will provide the actual deposit address
        // We just need to track the commitment and provide a placeholder
        
        // Generate a deterministic placeholder address from the secret
        // In production, the LP server provides the real address
        const primaryAddress = this.generatePlaceholderAddress();
        console.log('Placeholder Monero address:', primaryAddress);
        console.log('Note: LP server will provide actual deposit address');
        
        // Import Monero RPC client for read-only operations
        const { getMoneroRpc } = await import('./moneroRpc.js');
        const rpc = getMoneroRpc();
        
        // Store wallet instance with helper methods
        this.moneroWallet = {
            primaryAddress: primaryAddress,
            rpc: rpc,
            
            async getBalance() {
                console.warn('Balance checking handled by LP server');
                return 0n;
            },
            
            async sendTransaction(destination, amount) {
                throw new Error('Sending Monero transactions must be done through LP server or external wallet');
            },
            
            async scanForDeposit(expectedAmount, startHeight) {
                console.log('Deposit scanning handled by LP server');
                return null;
            },
            
            async scanForPTLC(secretHash, startHeight) {
                console.log('PTLC scanning handled by LP server');
                return null;
            },
            
            async claimPTLC(commitment, revealedSecret, destinationAddress) {
                throw new Error('PTLC claiming must be done through LP server or external wallet');
            },
            
            async getHeight() {
                return await rpc.getHeight();
            }
        };
    }

    /**
     * Generate a placeholder Monero address for display
     * In production, the LP server provides the actual deposit address
     */
    generatePlaceholderAddress() {
        // Return a placeholder that indicates LP will provide real address
        return 'LP_WILL_PROVIDE_ADDRESS';
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
