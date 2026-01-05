#!/usr/bin/env node

/**
 * Monero Oracle Service
 * 
 * Fetches Monero blockchain data and posts it to WrappedMonero contract
 * Runs every 2 minutes to keep the contract synchronized with Monero chain
 * 
 * Usage:
 *   node oracle/monero-oracle.js
 * 
 * Environment variables:
 *   ORACLE_PRIVATE_KEY - Private key of oracle account
 *   WRAPPED_MONERO_ADDRESS - Address of WrappedMonero contract
 *   RPC_URL - Ethereum RPC URL (default: Base Sepolia)
 *   MONERO_RPC_URL - Monero RPC URL (default: mainnet)
 *   INTERVAL_MS - Polling interval in milliseconds (default: 120000 = 2 min)
 */

require('dotenv').config();
const hre = require('hardhat');
const axios = require('axios');

// Configuration
const config = {
    oraclePrivateKey: process.env.ORACLE_PRIVATE_KEY,
    wrappedMoneroAddress: process.env.WRAPPED_MONERO_ADDRESS,
    rpcUrl: process.env.RPC_URL || 'https://sepolia.base.org',
    moneroRpcUrl: process.env.MONERO_RPC_URL || 'http://node.monerooutreach.org:18081',
    intervalMs: parseInt(process.env.INTERVAL_MS || '120000'), // 2 minutes
};

// Validate configuration
if (!config.oraclePrivateKey) {
    console.error('❌ ORACLE_PRIVATE_KEY not set in .env');
    process.exit(1);
}

if (!config.wrappedMoneroAddress) {
    console.error('❌ WRAPPED_MONERO_ADDRESS not set in .env');
    process.exit(1);
}

// Monero RPC helper
async function getMoneroBlockHeader(height = null) {
    try {
        const method = height !== null ? 'get_block_header_by_height' : 'get_last_block_header';
        const params = height !== null ? { height } : {};
        
        const response = await axios.post(config.moneroRpcUrl + '/json_rpc', {
            jsonrpc: '2.0',
            id: '0',
            method,
            params
        });
        
        if (response.data.error) {
            throw new Error(response.data.error.message);
        }
        
        return response.data.result.block_header;
    } catch (error) {
        console.error('❌ Monero RPC error:', error.message);
        throw error;
    }
}

// Post block to contract
async function postBlock(contract, blockHeight, blockHash, totalSupply) {
    try {
        console.log(`\n📤 Posting block ${blockHeight} to contract...`);
        console.log(`   Hash: ${blockHash}`);
        console.log(`   Supply: ${totalSupply} piconero`);
        
        const tx = await contract.postMoneroBlock(
            blockHeight,
            blockHash,
            totalSupply
        );
        
        console.log(`   TX: ${tx.hash}`);
        console.log(`   ⏳ Waiting for confirmation...`);
        
        const receipt = await tx.wait();
        
        console.log(`   ✅ Confirmed in block ${receipt.blockNumber}`);
        console.log(`   Gas used: ${receipt.gasUsed.toString()}`);
        
        return receipt;
    } catch (error) {
        if (error.message.includes('Block already posted')) {
            console.log(`   ⚠️  Block ${blockHeight} already posted`);
            return null;
        }
        throw error;
    }
}

// Main oracle loop
async function runOracle() {
    console.log('🔮 Monero Oracle Service Starting...\n');
    console.log('Configuration:');
    console.log(`   Monero RPC: ${config.moneroRpcUrl}`);
    console.log(`   Ethereum RPC: ${config.rpcUrl}`);
    console.log(`   WrappedMonero: ${config.wrappedMoneroAddress}`);
    console.log(`   Interval: ${config.intervalMs / 1000}s (${config.intervalMs / 60000} min)`);
    
    // Connect to contract
    const provider = new hre.ethers.JsonRpcProvider(config.rpcUrl);
    const wallet = new hre.ethers.Wallet(config.oraclePrivateKey, provider);
    
    console.log(`\n👤 Oracle address: ${wallet.address}`);
    
    const balance = await provider.getBalance(wallet.address);
    console.log(`   Balance: ${hre.ethers.formatEther(balance)} ETH`);
    
    if (balance === 0n) {
        console.error('\n❌ Oracle has no ETH for gas! Please fund the oracle address.');
        process.exit(1);
    }
    
    // Load contract
    const WrappedMonero = await hre.ethers.getContractFactory('WrappedMonero');
    const contract = WrappedMonero.attach(config.wrappedMoneroAddress).connect(wallet);
    
    // Verify oracle role
    const contractOracle = await contract.oracle();
    if (contractOracle.toLowerCase() !== wallet.address.toLowerCase()) {
        console.error(`\n❌ Wallet is not the oracle!`);
        console.error(`   Contract oracle: ${contractOracle}`);
        console.error(`   Wallet address: ${wallet.address}`);
        process.exit(1);
    }
    
    console.log('\n✅ Oracle verified and ready!\n');
    console.log('═'.repeat(70));
    
    // Main loop
    let lastPostedBlock = 0;
    
    async function poll() {
        try {
            console.log(`\n[${new Date().toISOString()}] 🔍 Checking Monero blockchain...`);
            
            // Get latest Monero block
            const header = await getMoneroBlockHeader();
            const blockHeight = header.height;
            const blockHash = '0x' + header.hash;
            const totalSupply = header.already_generated_coins; // in piconero
            
            console.log(`   Latest Monero block: ${blockHeight}`);
            console.log(`   Hash: ${blockHash}`);
            
            // Get last posted block from contract
            const latestPosted = await contract.latestMoneroBlock();
            console.log(`   Last posted block: ${latestPosted.toString()}`);
            
            // Post if new block available
            if (blockHeight > latestPosted) {
                console.log(`   📊 New block detected! Posting...`);
                await postBlock(contract, blockHeight, blockHash, totalSupply);
                lastPostedBlock = blockHeight;
            } else {
                console.log(`   ✅ Already up to date`);
            }
            
        } catch (error) {
            console.error('\n❌ Error in oracle loop:', error.message);
            console.error(error.stack);
        }
    }
    
    // Initial poll
    await poll();
    
    // Set up interval
    console.log(`\n⏰ Polling every ${config.intervalMs / 1000}s...`);
    setInterval(poll, config.intervalMs);
}

// Handle shutdown gracefully
process.on('SIGINT', () => {
    console.log('\n\n👋 Oracle shutting down...');
    process.exit(0);
});

process.on('SIGTERM', () => {
    console.log('\n\n👋 Oracle shutting down...');
    process.exit(0);
});

// Start oracle
runOracle().catch(error => {
    console.error('❌ Fatal error:', error);
    process.exit(1);
});
