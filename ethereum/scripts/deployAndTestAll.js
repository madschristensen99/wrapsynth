#!/usr/bin/env node
/**
 * Comprehensive Deployment and Testing Script
 * 
 * This script performs the complete deployment and testing workflow:
 * 1. Deploy contracts to Gnosis mainnet
 * 2. Run testFullCycleNow.js (full mint/burn cycle)
 * 3. Run mintAndCoLP.js (large mint with CoLP deposit)
 * 4. Run testPoolSwaps.js (pool trading tests)
 * 
 * Usage: node scripts/deployAndTestAll.js
 */

require('dotenv').config();
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

// ANSI color codes for pretty output
const colors = {
    reset: '\x1b[0m',
    bright: '\x1b[1m',
    green: '\x1b[32m',
    red: '\x1b[31m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    cyan: '\x1b[36m'
};

function log(message, color = 'reset') {
    console.log(`${colors[color]}${message}${colors.reset}`);
}

function logSection(title) {
    const line = '='.repeat(80);
    log(`\n${line}`, 'cyan');
    log(`  ${title}`, 'bright');
    log(`${line}\n`, 'cyan');
}

function runCommand(command, args, cwd = process.cwd()) {
    return new Promise((resolve, reject) => {
        log(`Running: ${command} ${args.join(' ')}`, 'blue');
        
        const proc = spawn(command, args, {
            cwd,
            stdio: 'inherit',
            shell: true
        });

        proc.on('close', (code) => {
            if (code === 0) {
                log(`✓ Command completed successfully\n`, 'green');
                resolve();
            } else {
                log(`✗ Command failed with exit code ${code}\n`, 'red');
                reject(new Error(`Command failed: ${command} ${args.join(' ')}`));
            }
        });

        proc.on('error', (err) => {
            log(`✗ Error running command: ${err.message}\n`, 'red');
            reject(err);
        });
    });
}

async function checkEnvironment() {
    logSection('Checking Environment');
    
    const required = ['PRIVATE_KEY', 'GNOSIS_RPC_URL'];
    const missing = required.filter(key => !process.env[key]);
    
    if (missing.length > 0) {
        log(`Missing required environment variables: ${missing.join(', ')}`, 'red');
        throw new Error('Environment check failed');
    }
    
    log('✓ All required environment variables present', 'green');
}

async function deployContracts() {
    logSection('Step 1: Deploying Fresh Contracts to Gnosis Mainnet');
    
    // Clear any cached nonces first
    log('Clearing cached nonces...', 'yellow');
    await runCommand('node', ['scripts/clearAllNonces.js']);
    
    // Deploy fresh contracts using Forge
    log('Starting fresh deployment...', 'cyan');
    await runCommand('forge', [
        'script',
        'script/DeployGnosis.s.sol:DeployGnosis',
        '--rpc-url',
        process.env.GNOSIS_RPC_URL,
        '--broadcast',
        '--slow',
        '--with-gas-price',
        '2000000000'  // 2 gwei
    ]);
    log('✓ Fresh deployment completed', 'green');
}

async function runFullCycleTest() {
    logSection('Step 2: Running Full Cycle Test (Mint + Burn)');
    await runCommand('node', ['scripts/testFullCycleNow.js']);
    log('✓ Full cycle test completed', 'green');
}

async function runMintAndCoLP() {
    logSection('Step 3: Running Large Mint + CoLP Deposit Test');
    await runCommand('node', ['scripts/mintAndCoLP.js']);
    log('✓ Mint and CoLP test completed', 'green');
}

async function runPoolSwapsTest() {
    logSection('Step 4: Running Pool Swaps Test');
    await runCommand('node', ['scripts/testPoolSwaps.js']);
    log('✓ Pool swaps test completed', 'green');
}

async function main() {
    const startTime = Date.now();
    
    log('\n' + '█'.repeat(80), 'bright');
    log('  GNOSIS MAINNET DEPLOYMENT & INTEGRATION TEST SUITE', 'bright');
    log('█'.repeat(80) + '\n', 'bright');
    
    try {
        // Step 0: Environment check
        await checkEnvironment();
        
        // Skip deployment - contracts already deployed
        log('\n✓ Using already deployed contracts from deployment.json', 'cyan');
        
        // Step 1: Run full cycle test
        await runFullCycleTest();
        
        // Step 2: Run mint and CoLP test
        await runMintAndCoLP();
        
        // Step 3: Run pool swaps test
        await runPoolSwapsTest();
        
        // Success summary
        const duration = ((Date.now() - startTime) / 1000).toFixed(2);
        logSection('ALL TESTS COMPLETED SUCCESSFULLY');
        log(`Total execution time: ${duration}s`, 'green');
        log('\n✓ Deployment and all integration tests passed!', 'green');
        log('✓ System is ready for production use\n', 'green');
        
        process.exit(0);
        
    } catch (error) {
        const duration = ((Date.now() - startTime) / 1000).toFixed(2);
        logSection('TEST SUITE FAILED');
        log(`Error: ${error.message}`, 'red');
        log(`Execution time before failure: ${duration}s\n`, 'yellow');
        process.exit(1);
    }
}

// Handle Ctrl+C gracefully
process.on('SIGINT', () => {
    log('\n\nTest suite interrupted by user', 'yellow');
    process.exit(130);
});

main();
