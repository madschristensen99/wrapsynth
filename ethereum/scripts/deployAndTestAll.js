#!/usr/bin/env node
/**
 * Single deploy + test entry point.
 *
 * 1. forge script DeployGnosis.s.sol --broadcast
 * 2. Parse console output for contract addresses
 * 3. Write deployment.json (root + frontend copy)
 * 4. Run testFullCycleNow.js, testCoLPNow.js, testPoolSwaps.js
 *
 * Usage: npm run deploy
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '..', '.env') });
require('dotenv').config();
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const c = {
    reset: '\x1b[0m', bright: '\x1b[1m', green: '\x1b[32m',
    red: '\x1b[31m', yellow: '\x1b[33m', cyan: '\x1b[36m',
};
const log = (m, color = 'reset') => console.log(`${c[color] || ''}${m}${c.reset}`);
function section(t) {
    const l = '='.repeat(70);
    log(`\n${l}`, 'cyan'); log(`  ${t}`, 'bright'); log(`${l}\n`, 'cyan');
}

// ── Run a command, capture stdout ─────────────────────────────────────────────
function runCmd(cmd, args, opts = {}) {
    return new Promise((resolve, reject) => {
        const proc = spawn(cmd, args, { stdio: ['inherit', 'pipe', 'inherit'], shell: true, ...opts });
        let stdout = '';
        proc.stdout.on('data', (d) => { process.stdout.write(d); stdout += d.toString(); });
        proc.on('close', (code) => code === 0 ? resolve(stdout) : reject(new Error(`${cmd} exited ${code}`)));
        proc.on('error', reject);
    });
}

function runInherit(cmd, args, opts = {}) {
    return new Promise((resolve, reject) => {
        const proc = spawn(cmd, args, { stdio: 'inherit', shell: true, ...opts });
        proc.on('close', (code) => code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`)));
        proc.on('error', reject);
    });
}

// ── Parse forge output for addresses ──────────────────────────────────────────
function parseAddresses(output) {
    const grab = (label) => {
        const re = new RegExp(`${label}:?\\s*(0x[0-9a-fA-F]{40})`);
        const m = output.match(re);
        return m ? m[1] : null;
    };
    const grabIndented = (label) => {
        const re = new RegExp(`${label}\\s+(0x[0-9a-fA-F]{40})`);
        const m = output.match(re);
        return m ? m[1] : null;
    };

    const addr = {
        wsXMR: grab('wsXMR deployed to'),
        wsXmrHub: grab('wsXmrHub deployed to'),
        liquidityRouter: grab('Router deployed to'),
        swapHelper: grab('SwapHelper deployed to'),
        RedStoneOracleFacet: grab('RedStoneOracleFacet deployed to'),
        VaultFacet: grab('VaultFacet deployed to'),
        MintFacet: grab('MintFacet deployed to'),
        BurnFacet: grab('BurnFacet deployed to'),
        LiquidationFacet: grab('LiquidationFacet deployed to'),
        YieldFacet: grab('YieldFacet deployed to'),
        pool: grabIndented('Uniswap V3 Pool'),
    };

    // Also try the summary section
    if (!addr.wsXMR) addr.wsXMR = grabIndented('wsXMR:');
    if (!addr.wsXmrHub) addr.wsXmrHub = grabIndented('wsXmrHub:');
    if (!addr.liquidityRouter) addr.liquidityRouter = grabIndented('LiquidityRouter:');
    if (!addr.swapHelper) addr.swapHelper = grabIndented('SwapHelper:');
    if (!addr.RedStoneOracleFacet) addr.RedStoneOracleFacet = grabIndented('OracleFacet:');
    if (!addr.VaultFacet) addr.VaultFacet = grabIndented('VaultFacet:');
    if (!addr.MintFacet) addr.MintFacet = grabIndented('MintFacet:');
    if (!addr.BurnFacet) addr.BurnFacet = grabIndented('BurnFacet:');
    if (!addr.LiquidationFacet) addr.LiquidationFacet = grabIndented('LiquidationFacet:');
    if (!addr.YieldFacet) addr.YieldFacet = grabIndented('YieldFacet:');
    if (!addr.pool) addr.pool = grabIndented('Uniswap V3 Pool:');

    return addr;
}

// ── Write deployment.json ─────────────────────────────────────────────────────
function writeDeployment(addr) {
    const deployerWallet = new (require('ethers').Wallet)(process.env.PRIVATE_KEY);

    const deployment = {
        network: 'Gnosis Chain Mainnet',
        chainId: 100,
        deploymentDate: new Date().toISOString(),
        rpcUrl: 'https://rpc.gnosischain.com',
        wsUrl: 'wss://rpc.gnosischain.com/wss',
        explorer: 'https://gnosisscan.io',
        contracts: {
            wsXMR: addr.wsXMR,
            wsXmrHub: addr.wsXmrHub,
            liquidityRouter: addr.liquidityRouter,
            swapHelper: addr.swapHelper,
            facets: {
                RedStoneOracleFacet: addr.RedStoneOracleFacet,
                VaultFacet: addr.VaultFacet,
                MintFacet: addr.MintFacet,
                BurnFacet: addr.BurnFacet,
                LiquidationFacet: addr.LiquidationFacet,
                YieldFacet: addr.YieldFacet,
            },
        },
        externalContracts: {
            sDAI: '0xaf204776c7245bF4147c2612BF6e5972Ee483701',
            wxDAI: '0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d',
            UniswapV3Factory: '0xe32F7dD7e3f098D518ff19A22d5f028e076489B1',
            UniswapV3PositionManager: '0xAE8fbE656a77519a7490054274910129c9244FA3',
            SwapHelper: addr.swapHelper,
            Ed25519Helper: '0xaECa36374039EAb9e267B5daa48bAb9Ab0e50F00',
        },
        pool: {
            uniswapV3Pool: addr.pool,
            feeTier: 3000,
        },
        urls: {
            moneroDaemon: 'https://xmr-node.cakewallet.com:18081',
            moneroNetwork: 'mainnet',
        },
        lpConfig: {
            defaultLpVault: deployerWallet.address,
            apiPort: 3001,
            minCollateralRatio: 150,
            liquidationThreshold: 120,
            targetCollateralRatio: 180,
        },
        verification: { status: 'pending', verifiedContracts: [] },
    };

    const rootPath = path.join(__dirname, '..', '..', 'deployment.json');
    const frontendPath = path.join(__dirname, '..', '..', 'frontend', 'deployment.json');
    const json = JSON.stringify(deployment, null, 2) + '\n';
    fs.writeFileSync(rootPath, json);
    fs.writeFileSync(frontendPath, json);
    log(`✓ deployment.json written (root + frontend)`, 'green');
    log(`  wsXMR:         ${addr.wsXMR}`, 'green');
    log(`  wsXmrHub:      ${addr.wsXmrHub}`, 'green');
    log(`  Router:        ${addr.liquidityRouter}`, 'green');
    log(`  Pool:          ${addr.pool}`, 'green');
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
    const t0 = Date.now();

    log('\n' + '█'.repeat(70), 'bright');
    log('  WRAPSYNTH — DEPLOY + TEST (single script)', 'bright');
    log('█'.repeat(70) + '\n', 'bright');

    // Env check
    const required = ['PRIVATE_KEY', 'GNOSIS_RPC_URL'];
    const missing = required.filter(k => !process.env[k]);
    if (missing.length) { log(`Missing env vars: ${missing.join(', ')}`, 'red'); process.exit(1); }
    log('✓ Environment OK', 'green');

    try {
        // ── Step 1: Deploy ────────────────────────────────────────────────────
        section('STEP 1: Deploy contracts to Gnosis');
        const forgeOutput = await runCmd('forge', [
            'script', 'script/DeployGnosis.s.sol:DeployGnosis',
            '--rpc-url', process.env.GNOSIS_RPC_URL,
            '--broadcast', '--slow',
        ]);

        // ── Step 2: Parse + write deployment.json ─────────────────────────────
        section('STEP 2: Update deployment.json');
        const addr = parseAddresses(forgeOutput);
        const missingAddr = Object.entries(addr).filter(([, v]) => !v).map(([k]) => k);
        if (missingAddr.length) {
            log(`⚠️  Could not parse: ${missingAddr.join(', ')}`, 'yellow');
            log('  You may need to manually update deployment.json', 'yellow');
        }
        writeDeployment(addr);

        // ── Step 3: testFullCycleNow ──────────────────────────────────────────
        section('STEP 3: testFullCycleNow (mint + burn)');
        await runInherit('node', ['scripts/testFullCycleNow.js']);

        // ── Step 4: testCoLPNow ───────────────────────────────────────────────
        section('STEP 4: testCoLPNow (co-LP position)');
        await runInherit('node', ['scripts/testCoLPNow.js']);

        // ── Step 5: testPoolSwaps ─────────────────────────────────────────────
        section('STEP 5: testPoolSwaps (pool trading)');
        await runInherit('node', ['scripts/testPoolSwaps.js']);

        // ── Done ──────────────────────────────────────────────────────────────
        const dur = ((Date.now() - t0) / 1000).toFixed(1);
        section('ALL DONE');
        log(`✓ Deploy + tests completed in ${dur}s`, 'green');
        log('✓ Frontend and lp-server will pick up new addresses from deployment.json\n', 'green');
        process.exit(0);
    } catch (err) {
        const dur = ((Date.now() - t0) / 1000).toFixed(1);
        section('FAILED');
        log(`Error: ${err.message}`, 'red');
        log(`After ${dur}s\n`, 'yellow');
        process.exit(1);
    }
}

process.on('SIGINT', () => { log('\nInterrupted', 'yellow'); process.exit(130); });
main();
