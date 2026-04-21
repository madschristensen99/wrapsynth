// Phantom Agent - Seed-Based Wallet for WrapSynth
// Uses BIP-39 seed phrases with encrypted browser storage
// EIP-7702 safe: seed phrases are true user-controlled secrets

import { toHex } from 'https://esm.sh/viem@2.7.0';
import { getUserAddress } from './viemClient.js';
import { createKeySet } from './seedManager.js';
import { storeSeed, loadSeed, hasStoredSeed } from './seedStorage.js';
import { showSeedGenerationModal, showSeedInputModal } from './seedUI.js';

/**
 * Phantom Agent State
 */
class PhantomAgent {
    constructor() {
        this.seed = null;            // BIP-39 seed phrase
        this.keySet = null;          // Derived keys (spend, view, message)
        this.secret = null;          // Private spend key (for contract)
        this.commitment = null;      // Ed25519 public key commitment
        this.moneroWallet = null;    // Monero wallet instance
        this.isInitialized = false;
        this.userWalletConnected = false;
    }

    /**
     * Initialize the Phantom Agent with seed phrase
     * @param {string} action - 'MINT' or 'BURN'
     * @param {string} amount - Amount in human-readable format
     * @param {string} destination - Optional destination address for burns
     * @param {string} existingSeed - Optional existing seed phrase
     */
    async initialize(action, amount, destination = null, existingSeed = null) {
        const address = getUserAddress();
        if (!address) {
            throw new Error('Wallet not connected');
        }

        console.log('Initializing Phantom Agent for', action);

        let seedData;
        
        if (existingSeed) {
            // Use provided seed
            console.log('Using provided seed phrase');
            this.seed = existingSeed;
            this.keySet = createKeySet(existingSeed);
            seedData = { seed: existingSeed, keySet: this.keySet };
        } else {
            // Check if we have a stored seed for this user
            // For new operations, we'll generate a new seed each time
            // Users can optionally store it for convenience
            console.log('Generating new seed phrase...');
            seedData = await showSeedGenerationModal();
            this.seed = seedData.seed;
            this.keySet = seedData.keySet;
        }

        // Extract secret and commitment from keySet
        this.secret = this.keySet.secret;
        this.commitment = this.keySet.commitment;
        
        console.log('Commitment generated:', this.commitment);
        console.log('Public spend key:', '0x' + this.keySet.publicSpendKey.toString(16));

        // Initialize Monero wallet interface
        await this.initializeMoneroWallet();

        this.isInitialized = true;

        return {
            secret: this.secret,
            commitment: this.commitment,
            moneroAddress: this.getMoneroAddress(),
            publicSpendKey: this.keySet.publicSpendKey,
            publicViewKey: this.keySet.publicViewKey
        };
    }

    /**
     * Load existing seed from encrypted storage or prompt user
     * @param {string} publicSpendKey - Public key to identify stored seed
     */
    async loadExistingSeed(publicSpendKey = null) {
        console.log('Attempting to load existing seed...');
        
        // Try to load from encrypted storage
        if (publicSpendKey && hasStoredSeed(publicSpendKey.toString(16))) {
            console.log('Found stored seed, requesting decryption...');
            const seed = await loadSeed(publicSpendKey.toString(16));
            if (seed) {
                this.seed = seed;
                this.keySet = createKeySet(seed);
                this.secret = this.keySet.secret;
                this.commitment = this.keySet.commitment;
                this.isInitialized = true;
                return true;
            }
        }
        
        // Prompt user to input seed
        console.log('Prompting user for seed phrase...');
        const seedData = await showSeedInputModal(publicSpendKey);
        this.seed = seedData.seed;
        this.keySet = seedData.keySet;
        this.secret = this.keySet.secret;
        this.commitment = this.keySet.commitment;
        this.isInitialized = true;
        return true;
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
     * Generate Monero address from keys
     * Note: This is a simplified placeholder
     * In production, use proper Monero address encoding
     */
    generatePlaceholderAddress() {
        if (this.keySet) {
            return this.keySet.moneroAddress;
        }
        return 'LP_WILL_PROVIDE_ADDRESS';
    }

    /**
     * Get the seed phrase (for backup/export)
     * WARNING: Only expose this when user explicitly requests it
     */
    getSeedPhrase() {
        if (!this.seed) {
            throw new Error('Agent not initialized');
        }
        return this.seed;
    }

    /**
     * Get the key set
     */
    getKeySet() {
        if (!this.keySet) {
            throw new Error('Agent not initialized');
        }
        return this.keySet;
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
     * Resume from existing seed phrase (for recovery)
     */
    async resumeFromSeed(seed) {
        this.seed = seed;
        this.keySet = createKeySet(seed);
        this.secret = this.keySet.secret;
        this.commitment = this.keySet.commitment;
        await this.initializeMoneroWallet();
        this.isInitialized = true;
        
        return {
            secret: this.secret,
            commitment: this.commitment,
            moneroAddress: this.getMoneroAddress(),
            publicSpendKey: this.keySet.publicSpendKey,
            publicViewKey: this.keySet.publicViewKey
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
