#!/usr/bin/env node

/**
 * Setup Monero Stagenet Wallet
 * 
 * This script helps you:
 * 1. Start monero-wallet-rpc for stagenet
 * 2. Create or restore a wallet
 * 3. Get stagenet XMR from faucet
 * 4. Send test transactions
 */

const { MoneroWalletIntegration, getStagenetFaucetInfo } = require('./moneroWalletIntegration');
const readline = require('readline');

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

function question(query) {
    return new Promise(resolve => rl.question(query, resolve));
}

async function main() {
    console.log('\n═══════════════════════════════════════════════════════');
    console.log('   Monero Stagenet Wallet Setup for ZeroXMR Testing');
    console.log('═══════════════════════════════════════════════════════\n');

    console.log('📋 Prerequisites:');
    console.log('   1. monero-wallet-rpc must be running on stagenet');
    console.log('   2. Command: monero-wallet-rpc --stagenet --rpc-bind-port 38083 --disable-rpc-login --wallet-dir ./stagenet-wallets');
    console.log('   3. Download from: https://www.getmonero.org/downloads/\n');

    const proceed = await question('Have you started monero-wallet-rpc? (yes/no): ');
    if (proceed.toLowerCase() !== 'yes') {
        console.log('\n⚠️  Please start monero-wallet-rpc first and run this script again.');
        rl.close();
        return;
    }

    const wallet = new MoneroWalletIntegration();

    try {
        // Connect to wallet RPC
        await wallet.connect();

        console.log('\n═══════════════════════════════════════════════════════');
        console.log('   Wallet Options');
        console.log('═══════════════════════════════════════════════════════\n');
        console.log('1. Create new wallet');
        console.log('2. Restore wallet from seed');
        console.log('3. Open existing wallet');

        const choice = await question('\nSelect option (1-3): ');

        let walletName = 'zeroxmr-test';
        let address;

        switch (choice) {
            case '1':
                walletName = await question('Wallet name (default: zeroxmr-test): ') || walletName;
                const result = await wallet.createWallet(walletName);
                address = result.address;
                
                console.log('\n⚠️  IMPORTANT: Save the seed phrase above!');
                console.log('   You will need it to restore your wallet.\n');
                
                getStagenetFaucetInfo();
                console.log(`\n   Your address: ${address}`);
                
                const getFaucet = await question('\nWould you like to open the faucet in your browser? (yes/no): ');
                if (getFaucet.toLowerCase() === 'yes') {
                    const { exec } = require('child_process');
                    exec('xdg-open https://stagenet.xmr.ditatompel.com/ || open https://stagenet.xmr.ditatompel.com/');
                }
                break;

            case '2':
                walletName = await question('Wallet name: ');
                const seed = await question('Enter seed phrase: ');
                const restoreHeight = await question('Restore height (0 for full scan): ');
                address = await wallet.restoreWallet(walletName, seed, 'password123', parseInt(restoreHeight) || 0);
                
                console.log('\n⏳ Wallet is now syncing... This may take a few minutes.');
                break;

            case '3':
                walletName = await question('Wallet name: ');
                address = await wallet.openWallet(walletName);
                break;

            default:
                console.log('Invalid option');
                rl.close();
                return;
        }

        // Show balance
        await new Promise(resolve => setTimeout(resolve, 2000)); // Wait for sync
        await wallet.getBalance();

        console.log('\n═══════════════════════════════════════════════════════');
        console.log('   Next Steps');
        console.log('═══════════════════════════════════════════════════════\n');
        console.log('1. If balance is 0, get stagenet XMR from faucet');
        console.log('2. Wait for transaction to confirm (~2 minutes)');
        console.log('3. Run: npm run test:stagenet-integration');
        console.log('4. This will send a test transaction and generate proofs\n');

        const testTx = await question('Would you like to send a test transaction now? (yes/no): ');
        if (testTx.toLowerCase() === 'yes') {
            const balance = await wallet.getBalance();
            if (balance.unlockedBalance > 0) {
                const amount = await question('Amount to send to self (XMR): ');
                await wallet.sendToSelf(parseFloat(amount));
                
                console.log('\n✅ Transaction sent! Wait for confirmation (~2 minutes)');
                console.log('   Then you can use this transaction for proof generation.\n');
            } else {
                console.log('\n⚠️  No unlocked balance. Get XMR from faucet first.\n');
            }
        }

        await wallet.close();

    } catch (error) {
        console.error('\n❌ Error:', error.message);
    }

    rl.close();
}

main().catch(console.error);
