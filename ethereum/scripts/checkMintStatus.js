#!/usr/bin/env node

/**
 * Check Mint Status - Diagnostic tool for stuck mints
 * 
 * Usage:
 *   node scripts/checkMintStatus.js [requestId]
 *   node scripts/checkMintStatus.js --all
 */

const { createPublicClient, http, createWalletClient, formatEther } = require('viem');
const { gnosis } = require('viem/chains');
const { privateKeyToAccount } = require('viem/accounts');
const fs = require('fs');
const path = require('path');

// Load deployment config
const deploymentPath = path.join(__dirname, '../../deployment.json');
const deployment = JSON.parse(fs.readFileSync(deploymentPath, 'utf8'));

const HUB_ADDRESS = deployment.contracts.wsXmrHub;
const LP_VAULT = deployment.lpConfig.defaultLpVault;

// Minimal ABI for reading mint requests
const HUB_ABI = [
    {
        inputs: [{ name: 'user', type: 'address' }],
        name: 'getUserMintRequests',
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
        inputs: [{ name: 'lpVault', type: 'address' }],
        name: 'getVaultPendingMints',
        outputs: [{ name: '', type: 'bytes32[]' }],
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
    
    const publicClient = createPublicClient({
        chain: gnosis,
        transport: http(deployment.rpcUrl || 'https://rpc.gnosischain.com')
    });

    const currentBlock = await publicClient.getBlockNumber();
    console.log(`\n📊 Current block: ${currentBlock}\n`);

    if (args.includes('--all')) {
        // Check all mints for the LP vault
        console.log(`🔍 Checking all pending mints for LP vault: ${LP_VAULT}\n`);
        
        const requestIds = await publicClient.readContract({
            address: HUB_ADDRESS,
            abi: HUB_ABI,
            functionName: 'getVaultPendingMints',
            args: [LP_VAULT]
        });

        console.log(`Found ${requestIds.length} pending mint(s)\n`);

        for (const requestId of requestIds) {
            await checkMint(publicClient, requestId, currentBlock);
            console.log('---\n');
        }
    } else if (args.length > 0) {
        // Check specific mint
        const requestId = args[0];
        await checkMint(publicClient, requestId, currentBlock);
    } else {
        console.log('Usage:');
        console.log('  node scripts/checkMintStatus.js <requestId>');
        console.log('  node scripts/checkMintStatus.js --all');
        process.exit(1);
    }
}

async function checkMint(publicClient, requestId, currentBlock) {
    try {
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
        const wsxmrAmount = Number(mint.wsxmrAmount) / 1e8;
        const isExpired = currentBlock >= timeout;
        const hasLpKey = lpPublicKey !== '0x0000000000000000000000000000000000000000000000000000000000000000';

        console.log(`Request ID: ${requestId}`);
        console.log(`Status: ${STATUS_NAMES[status]} (${status})`);
        console.log(`User: ${mint.initiator}`);
        console.log(`LP Vault: ${mint.lpVault}`);
        console.log(`Amount: ${xmrAmount.toFixed(6)} XMR → ${wsxmrAmount.toFixed(8)} wsXMR`);
        console.log(`Timeout: Block ${timeout} ${isExpired ? '⚠️  EXPIRED' : '✅ Valid'}`);
        console.log(`Griefing Deposit: ${formatEther(mint.griefingDeposit)} xDAI`);
        console.log(`LP Bond: ${formatEther(mint.lpBond)} xDAI`);
        console.log(`LP Key Provided: ${hasLpKey ? '✅ Yes' : '❌ No'}`);

        // Diagnosis
        console.log('\n💡 Diagnosis:');
        if (status === 4) {
            console.log('✅ Mint is COMPLETED - user has received wsXMR');
        } else if (status === 5) {
            console.log('❌ Mint is CANCELLED - griefing deposit should be refunded');
        } else if (isExpired) {
            console.log('⚠️  Mint has EXPIRED - can be cancelled to recover deposits');
            console.log('   Action: Call cancelMint() to recover griefing deposit');
        } else if (status === 3) {
            console.log('⏳ Mint is READY - waiting for user to finalize');
            console.log('   Action: User needs to call finalizeMint() with their secret');
        } else if (status === 2) {
            console.log('⏳ LP key provided - LP is verifying XMR deposit');
            console.log('   Action: LP node should call setMintReady() after confirming XMR');
        } else if (status === 1) {
            if (hasLpKey) {
                console.log('⏳ Waiting for user to send XMR to deposit address');
                console.log('   Action: User should send XMR, then LP will verify and call setMintReady()');
            } else {
                console.log('⏳ Waiting for LP to provide public keys');
                console.log('   Action: LP node should call provideLPKey()');
            }
        } else {
            console.log('❓ Unknown status');
        }

    } catch (error) {
        console.error(`Error checking mint ${requestId}:`, error.message);
    }
}

main().catch(console.error);
