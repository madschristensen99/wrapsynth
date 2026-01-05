const moneroTs = require('monero-ts');

/**
 * Monero Stagenet Wallet Integration
 * 
 * Provides functions to:
 * 1. Connect to monero-wallet-rpc on stagenet
 * 2. Create/restore wallets
 * 3. Send transactions and get outputs
 * 4. Extract proof data (ECDH amounts, keys, etc.)
 */

class MoneroWalletIntegration {
    constructor(rpcUrl = 'http://localhost:38083', daemonUrl = 'http://stagenet.community.rino.io:38081') {
        this.rpcUrl = rpcUrl;
        this.daemonUrl = daemonUrl;
        this.wallet = null;
        this.daemon = null;
    }

    /**
     * Connect to stagenet wallet RPC
     */
    async connect() {
        try {
            // Connect to wallet RPC
            this.wallet = await moneroTs.connectToWalletRpc(this.rpcUrl);
            console.log('✅ Connected to monero-wallet-rpc');
            
            // Connect to daemon for blockchain queries
            this.daemon = await moneroTs.connectToDaemonRpc(this.daemonUrl);
            console.log('✅ Connected to stagenet daemon');
            
            return true;
        } catch (error) {
            console.error('❌ Failed to connect:', error.message);
            throw error;
        }
    }

    /**
     * Create a new stagenet wallet
     */
    async createWallet(walletName, password = 'password123') {
        try {
            await this.wallet.createWallet({
                path: walletName,
                password: password,
                language: 'English'
            });
            
            const seed = await this.wallet.getMnemonic();
            const address = await this.wallet.getPrimaryAddress();
            
            console.log('\n🎉 Wallet created!');
            console.log(`   Name: ${walletName}`);
            console.log(`   Address: ${address}`);
            console.log(`   Seed: ${seed}`);
            console.log('\n⚠️  SAVE THIS SEED PHRASE SECURELY!\n');
            
            return { address, seed };
        } catch (error) {
            console.error('❌ Failed to create wallet:', error.message);
            throw error;
        }
    }

    /**
     * Restore wallet from seed
     */
    async restoreWallet(walletName, seed, password = 'password123', restoreHeight = 0) {
        try {
            await this.wallet.createWallet({
                path: walletName,
                password: password,
                mnemonic: seed,
                restoreHeight: restoreHeight
            });
            
            const address = await this.wallet.getPrimaryAddress();
            console.log(`✅ Wallet restored: ${address}`);
            
            return address;
        } catch (error) {
            console.error('❌ Failed to restore wallet:', error.message);
            throw error;
        }
    }

    /**
     * Open existing wallet
     */
    async openWallet(walletName, password = 'password123') {
        try {
            await this.wallet.openWallet(walletName, password);
            const address = await this.wallet.getPrimaryAddress();
            console.log(`✅ Wallet opened: ${address}`);
            return address;
        } catch (error) {
            console.error('❌ Failed to open wallet:', error.message);
            throw error;
        }
    }

    /**
     * Get wallet balance
     */
    async getBalance() {
        const balance = await this.wallet.getBalance();
        const unlockedBalance = await this.wallet.getUnlockedBalance();
        
        console.log(`\n💰 Balance:`);
        console.log(`   Total: ${balance.toString() / 1e12} XMR`);
        console.log(`   Unlocked: ${unlockedBalance.toString() / 1e12} XMR`);
        
        return { balance, unlockedBalance };
    }

    /**
     * Send a transaction to yourself to create controlled outputs
     */
    async sendToSelf(amount) {
        try {
            const address = await this.wallet.getPrimaryAddress();
            
            console.log(`\n📤 Sending ${amount} XMR to self...`);
            
            const tx = await this.wallet.createTx({
                accountIndex: 0,
                address: address,
                amount: BigInt(Math.floor(amount * 1e12)) // Convert to piconero
            });
            
            await this.wallet.relayTx(tx);
            
            console.log(`✅ Transaction sent!`);
            console.log(`   TX Hash: ${tx.getHash()}`);
            console.log(`   Fee: ${tx.getFee().toString() / 1e12} XMR`);
            
            return tx;
        } catch (error) {
            console.error('❌ Failed to send transaction:', error.message);
            throw error;
        }
    }

    /**
     * Get transaction details and extract proof data
     */
    async getTransactionProofData(txHash) {
        try {
            console.log(`\n🔍 Fetching transaction: ${txHash}`);
            
            // Get transaction from wallet
            const txs = await this.wallet.getTxs({ txHash: txHash });
            if (!txs || txs.length === 0) {
                throw new Error('Transaction not found in wallet');
            }
            
            const tx = txs[0];
            
            // Get full transaction from daemon
            const txHex = await this.daemon.getTx(txHash);
            
            // Parse transaction to get outputs
            const outputs = tx.getOutgoingTransfer().getDestinations();
            
            console.log(`\n📦 Transaction Details:`);
            console.log(`   Hash: ${tx.getHash()}`);
            console.log(`   Block Height: ${tx.getHeight()}`);
            console.log(`   Outputs: ${outputs.length}`);
            
            // Extract proof data for each output
            const proofData = [];
            for (let i = 0; i < outputs.length; i++) {
                const output = outputs[i];
                
                // Get output keys and ECDH info
                const outputData = {
                    txHash: tx.getHash(),
                    outputIndex: i,
                    amount: output.getAmount().toString(), // in piconero
                    address: output.getAddress(),
                    // These would come from parsing the raw transaction
                    // For now, we'll need to extract from tx hex
                };
                
                proofData.push(outputData);
                
                console.log(`\n   Output ${i}:`);
                console.log(`      Amount: ${output.getAmount().toString() / 1e12} XMR`);
                console.log(`      Address: ${output.getAddress()}`);
            }
            
            return {
                tx,
                proofData,
                txHex
            };
        } catch (error) {
            console.error('❌ Failed to get transaction data:', error.message);
            throw error;
        }
    }

    /**
     * Extract ECDH encrypted amount and keys from raw transaction
     * This is what we need to post on-chain and prove against
     */
    async extractOutputData(txHash, outputIndex) {
        try {
            // Get raw transaction hex
            const txHex = await this.daemon.getTx(txHash);
            
            // Parse transaction
            // Note: monero-ts might not expose all low-level parsing
            // We may need to use monero-javascript or custom parsing
            
            console.log(`\n🔐 Extracting output data for TX ${txHash}, output ${outputIndex}`);
            
            // This is where we'd extract:
            // - ecdhAmount (ECDH encrypted amount)
            // - outputPubKey (one-time public key)
            // - commitment (Pedersen commitment)
            
            // For now, return placeholder structure
            return {
                txHash,
                outputIndex,
                ecdhAmount: '0x' + '00'.repeat(32), // 32-byte ECDH encrypted amount
                outputPubKey: '0x' + '00'.repeat(32), // 32-byte public key
                commitment: '0x' + '00'.repeat(32), // 32-byte commitment
                blockHeight: 0
            };
        } catch (error) {
            console.error('❌ Failed to extract output data:', error.message);
            throw error;
        }
    }

    /**
     * Close wallet
     */
    async close() {
        if (this.wallet) {
            await this.wallet.close();
            console.log('✅ Wallet closed');
        }
    }
}

/**
 * Helper: Get stagenet faucet info
 */
function getStagenetFaucetInfo() {
    console.log('\n💧 Stagenet Faucet Information:');
    console.log('   URL: https://stagenet.xmr.ditatompel.com/');
    console.log('   Alternative: https://community.rino.io/faucet/stagenet/');
    console.log('\n   Steps:');
    console.log('   1. Create a stagenet wallet');
    console.log('   2. Get your address');
    console.log('   3. Visit faucet and request XMR');
    console.log('   4. Wait for transaction to confirm (~2 minutes)');
}

module.exports = {
    MoneroWalletIntegration,
    getStagenetFaucetInfo
};
