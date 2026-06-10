#!/usr/bin/env node

/**
 * Check Monero Wallet Balance and Recent Transfers
 */

const axios = require('axios');

const WALLET_RPC_URL = 'http://127.0.0.1:28383/json_rpc';

async function callWalletRPC(method, params = {}) {
    try {
        const response = await axios.post(WALLET_RPC_URL, {
            jsonrpc: '2.0',
            id: '0',
            method,
            params
        });
        
        if (response.data.error) {
            throw new Error(`RPC Error: ${response.data.error.message}`);
        }
        
        return response.data.result;
    } catch (error) {
        if (error.code === 'ECONNREFUSED') {
            throw new Error('Wallet RPC not running. Start it with: monero-wallet-rpc ...');
        }
        throw error;
    }
}

async function main() {
    console.log('\n🔍 Checking Monero Wallet Status\n');
    
    try {
        // Get balance
        const balance = await callWalletRPC('get_balance', { account_index: 0 });
        const totalBalance = Number(balance.balance) / 1e12;
        const unlockedBalance = Number(balance.unlocked_balance) / 1e12;
        
        console.log('💰 Balance:');
        console.log(`   Total: ${totalBalance.toFixed(12)} XMR`);
        console.log(`   Unlocked: ${unlockedBalance.toFixed(12)} XMR`);
        console.log(`   Locked: ${(totalBalance - unlockedBalance).toFixed(12)} XMR\n`);
        
        // Get recent transfers (last 50 blocks)
        const height = await callWalletRPC('get_height');
        const currentHeight = height.height;
        const minHeight = Math.max(0, currentHeight - 100);
        
        console.log(`📊 Current height: ${currentHeight}\n`);
        
        // Get incoming transfers
        try {
            const transfers = await callWalletRPC('get_transfers', {
                in: true,
                out: true,
                pending: true,
                failed: true,
                pool: true,
                min_height: minHeight
            });
            
            console.log('📥 Recent Transfers (last 100 blocks):\n');
            
            let hasTransfers = false;
            
            if (transfers.in && transfers.in.length > 0) {
                console.log('  Incoming:');
                for (const tx of transfers.in.slice(-10)) {
                    const amount = Number(tx.amount) / 1e12;
                    console.log(`    ${tx.txid.substring(0, 16)}... | ${amount.toFixed(12)} XMR | Height: ${tx.height} | ${tx.confirmations} confirmations`);
                    hasTransfers = true;
                }
                console.log();
            }
            
            if (transfers.out && transfers.out.length > 0) {
                console.log('  Outgoing:');
                for (const tx of transfers.out.slice(-10)) {
                    const amount = Number(tx.amount) / 1e12;
                    console.log(`    ${tx.txid.substring(0, 16)}... | ${amount.toFixed(12)} XMR | Height: ${tx.height} | ${tx.confirmations} confirmations`);
                    hasTransfers = true;
                }
                console.log();
            }
            
            if (transfers.pending && transfers.pending.length > 0) {
                console.log('  Pending:');
                for (const tx of transfers.pending) {
                    const amount = Number(tx.amount) / 1e12;
                    console.log(`    ${tx.txid.substring(0, 16)}... | ${amount.toFixed(12)} XMR | PENDING`);
                    hasTransfers = true;
                }
                console.log();
            }
            
            if (!hasTransfers) {
                console.log('  No recent transfers found\n');
            }
            
        } catch (error) {
            console.log('  No transfers found or error:', error.message, '\n');
        }
        
        // Get address
        const address = await callWalletRPC('get_address', { account_index: 0 });
        console.log('📍 Primary Address:');
        console.log(`   ${address.address}\n`);
        
    } catch (error) {
        console.error('❌ Error:', error.message);
        process.exit(1);
    }
}

main().catch(console.error);
