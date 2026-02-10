const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

/**
 * Relayer Service
 * Monitors for mint intents and executes them for privacy
 */
class RelayerService {
    constructor(config) {
        this.relayerAddress = config.relayerAddress;
        this.wrappedMoneroAddress = config.wrappedMoneroAddress;
        this.relayerWallet = config.relayerWallet;
        this.intentQueueFile = config.intentQueueFile || "./relayer-queue.json";
        this.pollInterval = config.pollInterval || 10000; // 10 seconds
        this.running = false;
    }

    /**
     * Initialize contracts
     */
    async init() {
        this.relayerContract = await ethers.getContractAt(
            "MintRelayer",
            this.relayerAddress,
            this.relayerWallet
        );
        
        this.wrappedMoneroContract = await ethers.getContractAt(
            "WrappedMonero",
            this.wrappedMoneroAddress,
            this.relayerWallet
        );

        console.log("✅ Relayer service initialized");
        console.log(`   Relayer: ${this.relayerAddress}`);
        console.log(`   Wallet: ${this.relayerWallet.address}`);
    }

    /**
     * Register as a relayer
     */
    async register(stakeAmount) {
        console.log(`📝 Registering relayer with ${ethers.formatEther(stakeAmount)} ETH stake...`);
        
        const tx = await this.relayerContract.registerRelayer({
            value: stakeAmount
        });
        await tx.wait();
        
        console.log("✅ Relayer registered");
    }

    /**
     * Load intent queue from file
     */
    loadQueue() {
        if (fs.existsSync(this.intentQueueFile)) {
            const data = fs.readFileSync(this.intentQueueFile, "utf8");
            return JSON.parse(data);
        }
        return [];
    }

    /**
     * Save intent queue to file
     */
    saveQueue(queue) {
        fs.writeFileSync(this.intentQueueFile, JSON.stringify(queue, null, 2));
    }

    /**
     * Add intent to queue
     */
    async addIntent(intentData) {
        const queue = this.loadQueue();
        
        // Add timestamp and status
        intentData.addedAt = Date.now();
        intentData.status = "pending";
        
        queue.push(intentData);
        this.saveQueue(queue);
        
        console.log(`📥 Added intent to queue: ${intentData.intent.recipient}`);
    }

    /**
     * Process a single intent
     */
    async processIntent(intentData) {
        const { intent, signature, proofData } = intentData;
        
        console.log(`\n🔄 Processing intent for ${intent.recipient}...`);
        console.log(`   Amount: ${ethers.formatUnits(intent.expectedAmount, 12)} XMR`);
        console.log(`   LP: ${intent.lp}`);
        
        try {
            // Check if intent is still valid
            const currentTime = Math.floor(Date.now() / 1000);
            if (currentTime > intent.deadline) {
                console.log("⏰ Intent expired");
                return { success: false, reason: "expired" };
            }

            // Verify nonce
            const currentNonce = await this.relayerContract.getNonce(intent.signer);
            if (currentNonce.toString() !== intent.nonce.toString()) {
                console.log("❌ Invalid nonce");
                return { success: false, reason: "invalid_nonce" };
            }

            // Execute relayed mint
            console.log("📤 Submitting transaction...");
            
            const tx = await this.relayerContract.relayMint(
                intent,
                signature,
                proofData.proof,
                proofData.publicSignals,
                proofData.dleqProof,
                proofData.ed25519Proof,
                proofData.output,
                proofData.blockHeight,
                proofData.txMerkleProof,
                proofData.txIndex,
                proofData.outputMerkleProof,
                proofData.outputIndex,
                proofData.priceUpdateData || [],
                {
                    gasLimit: 5000000 // High gas limit for complex proof verification
                }
            );

            console.log(`   TX: ${tx.hash}`);
            const receipt = await tx.wait();
            
            console.log(`✅ Mint relayed successfully!`);
            console.log(`   Gas used: ${receipt.gasUsed.toString()}`);
            
            return { success: true, txHash: tx.hash };
            
        } catch (error) {
            console.error("❌ Error processing intent:", error.message);
            return { success: false, reason: error.message };
        }
    }

    /**
     * Process all pending intents in queue
     */
    async processQueue() {
        const queue = this.loadQueue();
        const updatedQueue = [];
        
        for (const intentData of queue) {
            if (intentData.status === "pending") {
                const result = await this.processIntent(intentData);
                
                if (result.success) {
                    intentData.status = "completed";
                    intentData.txHash = result.txHash;
                    intentData.completedAt = Date.now();
                } else if (result.reason === "expired") {
                    intentData.status = "expired";
                } else {
                    // Keep as pending for retry
                    intentData.retries = (intentData.retries || 0) + 1;
                    if (intentData.retries > 3) {
                        intentData.status = "failed";
                        intentData.failureReason = result.reason;
                    }
                }
            }
            
            // Keep recent intents in queue for history
            const ageHours = (Date.now() - intentData.addedAt) / (1000 * 60 * 60);
            if (ageHours < 24) {
                updatedQueue.push(intentData);
            }
        }
        
        this.saveQueue(updatedQueue);
    }

    /**
     * Start relayer service
     */
    async start() {
        console.log("\n🚀 Starting relayer service...");
        this.running = true;
        
        while (this.running) {
            try {
                await this.processQueue();
            } catch (error) {
                console.error("Error in relayer loop:", error);
            }
            
            // Wait before next poll
            await new Promise(resolve => setTimeout(resolve, this.pollInterval));
        }
    }

    /**
     * Stop relayer service
     */
    stop() {
        console.log("\n🛑 Stopping relayer service...");
        this.running = false;
    }

    /**
     * Get queue status
     */
    getStatus() {
        const queue = this.loadQueue();
        const status = {
            total: queue.length,
            pending: queue.filter(i => i.status === "pending").length,
            completed: queue.filter(i => i.status === "completed").length,
            failed: queue.filter(i => i.status === "failed").length,
            expired: queue.filter(i => i.status === "expired").length
        };
        return status;
    }
}

module.exports = RelayerService;
