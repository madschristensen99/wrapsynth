#!/usr/bin/env node

/**
 * Resolve Stuck Mints - Automated recovery tool
 * 
 * This script:
 * 1. Checks all pending mints for the LP vault
 * 2. Identifies which ones need LP action (provideLPKey, setMintReady)
 * 3. Identifies which ones are expired and should be cancelled
 * 4. Optionally executes the fixes
 * 
 * Usage:
 *   node scripts/resolveMints.js --check     # Dry run
 *   node scripts/resolveMints.js --fix       # Execute fixes
 */

const { createPublicClient, createWalletClient, http, formatEther } = require('viem');
const { gnosis } = require('viem/chains');
const { privateKeyToAccount } = require('viem/accounts');
const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '../lp-node/.env') });

// Load deployment config
const deploymentPath = path.join(__dirname, '../../deployment.json');
const deployment = JSON.parse(fs.readFileSync(deploymentPath, 'utf8'));

const HUB_ADDRESS = deployment.contracts.wsXmrHub;
const LP_VAULT = deployment.lpConfig.defaultLpVault;

const HUB_ABI = [
    {
        inputs: [{ name: 'lpVault', type: 'address' }],
        name: 'getVaultPendingMints',
        outputs: [{ name: '', type: 'bytes32[]' }],
        stateMutability: 'view',
        type: 'function'
    },
    {
        inputs: [{ name: 'requestId', type: 'bytes32' }],
        name: 'getMintRequest',
        outputs: [{
            components: [
                { name: 'requestId', type: 'bytes32' },
                { name: 'initiator', type: 'address' },
                { name: 'recipient', type: 'address' },
                { name: 'lpVault', type: 'address' },
                { name: 'xmrAmount', type: 'uint256' },
                { name: 'wsxmrAmount', type: 'uint256' },
                { name: 'feeAmount', type: 'uint256' },
                { name: 'claimCommitment', type: 'bytes32' },
                { name: 'userPublicKey', type: 'bytes32' },
                { name: 'timeout', type: 'uint256' },
                { name: 'griefingDeposit', type: 'uint256' },
                { name: 'lpBond', type: 'uint256' },
                { name: 'normalizedDebtAmount', type: 'uint256' },
                { name: 'vaultMintNonce', type: 'uint256' },
                { name: 'status', type: 'uint8' }
            ],
            name: '',
            type: 'tuple'
        }],
        stateMutability: 'view',
        type: 'function'
    },
    {
        inputs: [{ name: 'requestId', type: 'bytes32' }],
        name: 'lpPublicKeys',
        outputs: [{ name: '', type: 'bytes32' }],
        stateMutability: 'view',
        type: 'function'
    },
    {
        inputs: [{ name: 'requestId', type: 'bytes32' }],
        name: 'cancelMint',
        outputs: [],
        stateMutability: 'nonpayable',
        type: 'function'
    }
];

const STATUS_NAMES = {
    0: 'INVALID',
    1: 'PENDING',
    2: 'KEY_PROVIDED',
    3: 'READY',
    4: 'COMPLETED',
    5: 'CANCELLED'
};

async function main() {
    const args = process.argv.slice(2);
    const dryRun = !args.includes('--fix');

    if (dryRun) {
        console.log('🔍 DRY RUN MODE - No transactions will be sent\n');
        console.log('   Run with --fix to execute actions\n');
    }

    const publicClient = createPublicClient({
        chain: gnosis,
        transport: http(deployment.rpcUrl || 'https://rpc.gnosischain.com')
    });

    let walletClient;
    if (!dryRun) {
        if (!process.env.PRIVATE_KEY) {
            console.error('❌ PRIVATE_KEY not found in lp-node/.env');
            process.exit(1);
        }
        const account = privateKeyToAccount(process.env.PRIVATE_KEY);
        walletClient = createWalletClient({
            account,
            chain: gnosis,
            transport: http(deployment.rpcUrl || 'https://rpc.gnosischain.com')
        });
        console.log(`🔑 Using LP account: ${account.address}\n`);
    }

    const currentBlock = await publicClient.getBlockNumber();
    console.log(`📊 Current block: ${currentBlock}\n`);

    // Get all pending mints
    const requestIds = await publicClient.readContract({
        address: HUB_ADDRESS,
        abi: HUB_ABI,
        functionName: 'getVaultPendingMints',
        args: [LP_VAULT]
    });

    console.log(`Found ${requestIds.length} pending mint(s) for LP vault ${LP_VAULT}\n`);

    const actions = {
        needsLpKey: [],
        needsSetReady: [],
        expired: [],
        waitingForUser: [],
        ready: []
    };

    // Analyze each mint
    for (const requestId of requestIds) {
        const mint = await publicClient.readContract({
            address: HUB_ADDRESS,
            abi: HUB_ABI,
            functionName: 'getMintRequest',
            args: [requestId]
        });

        const lpPublicKey = await publicClient.readContract({
            address: HUB_ADDRESS,
            abi: HUB_ABI,
            functionName: 'lpPublicKeys',
            args: [requestId]
        });

        const status = Number(mint.status);
        const timeout = Number(mint.timeout);
        const xmrAmount = Number(mint.xmrAmount) / 1e12;
        const isExpired = currentBlock >= timeout;
        const hasLpKey = lpPublicKey !== '0x0000000000000000000000000000000000000000000000000000000000000000';

        const info = {
            requestId,
            status,
            statusName: STATUS_NAMES[status],
            xmrAmount,
            timeout,
            isExpired,
            hasLpKey,
            initiator: mint.initiator
        };

        if (isExpired && status !== 4 && status !== 5) {
            actions.expired.push(info);
        } else if (status === 1 && !hasLpKey) {
            actions.needsLpKey.push(info);
        } else if (status === 2) {
            actions.needsSetReady.push(info);
        } else if (status === 3) {
            actions.ready.push(info);
        } else if (status === 1 && hasLpKey) {
            actions.waitingForUser.push(info);
        }
    }

    // Report findings
    console.log('═══════════════════════════════════════════════════════\n');
    
    if (actions.expired.length > 0) {
        console.log(`⚠️  ${actions.expired.length} EXPIRED mint(s) - can be cancelled:\n`);
        for (const mint of actions.expired) {
            console.log(`   ${mint.requestId.slice(0, 14)}... - ${mint.xmrAmount.toFixed(6)} XMR - Status: ${mint.statusName}`);
        }
        console.log('');
    }

    if (actions.needsLpKey.length > 0) {
        console.log(`🔑 ${actions.needsLpKey.length} mint(s) need LP to provide keys:\n`);
        for (const mint of actions.needsLpKey) {
            console.log(`   ${mint.requestId.slice(0, 14)}... - ${mint.xmrAmount.toFixed(6)} XMR`);
        }
        console.log('   ⚠️  LP node should be running to handle these automatically\n');
    }

    if (actions.needsSetReady.length > 0) {
        console.log(`⏳ ${actions.needsSetReady.length} mint(s) need LP to verify and call setMintReady:\n`);
        for (const mint of actions.needsSetReady) {
            console.log(`   ${mint.requestId.slice(0, 14)}... - ${mint.xmrAmount.toFixed(6)} XMR`);
        }
        console.log('   ⚠️  LP node should verify XMR deposits and call setMintReady()\n');
    }

    if (actions.ready.length > 0) {
        console.log(`✅ ${actions.ready.length} mint(s) are READY - waiting for user to finalize:\n`);
        for (const mint of actions.ready) {
            console.log(`   ${mint.requestId.slice(0, 14)}... - ${mint.xmrAmount.toFixed(6)} XMR - User: ${mint.initiator}`);
        }
        console.log('');
    }

    if (actions.waitingForUser.length > 0) {
        console.log(`💰 ${actions.waitingForUser.length} mint(s) waiting for user to send XMR:\n`);
        for (const mint of actions.waitingForUser) {
            console.log(`   ${mint.requestId.slice(0, 14)}... - ${mint.xmrAmount.toFixed(6)} XMR`);
        }
        console.log('');
    }

    console.log('═══════════════════════════════════════════════════════\n');

    // Execute fixes if requested
    if (!dryRun && actions.expired.length > 0) {
        console.log('🔧 Cancelling expired mints...\n');
        
        for (const mint of actions.expired) {
            try {
                console.log(`   Cancelling ${mint.requestId.slice(0, 14)}...`);
                const hash = await walletClient.writeContract({
                    address: HUB_ADDRESS,
                    abi: HUB_ABI,
                    functionName: 'cancelMint',
                    args: [mint.requestId]
                });
                console.log(`   ✅ Tx: ${hash}\n`);
                
                // Wait for confirmation
                await publicClient.waitForTransactionReceipt({ hash });
            } catch (error) {
                console.error(`   ❌ Failed: ${error.message}\n`);
            }
        }
    }

    // Summary
    console.log('\n📋 Summary:');
    console.log(`   Total pending: ${requestIds.length}`);
    console.log(`   Expired (can cancel): ${actions.expired.length}`);
    console.log(`   Need LP keys: ${actions.needsLpKey.length}`);
    console.log(`   Need setMintReady: ${actions.needsSetReady.length}`);
    console.log(`   Ready for user: ${actions.ready.length}`);
    console.log(`   Waiting for XMR: ${actions.waitingForUser.length}`);

    if (dryRun && (actions.expired.length > 0 || actions.needsLpKey.length > 0 || actions.needsSetReady.length > 0)) {
        console.log('\n💡 Next steps:');
        if (actions.expired.length > 0) {
            console.log('   • Run with --fix to cancel expired mints');
        }
        if (actions.needsLpKey.length > 0 || actions.needsSetReady.length > 0) {
            console.log('   • Start the LP node to process pending mints:');
            console.log('     cd ethereum/lp-node && cargo run');
        }
    }
}

main().catch(console.error);
