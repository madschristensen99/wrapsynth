#!/usr/bin/env node
/**
 * Single deploy + test entry point (oracle-free protocol).
 *
 * 1. forge script script/Deploy<Chain>.s.sol --broadcast
 * 2. Parse console output for contract addresses
 * 3. Write deployments/<chain>-deployment.json + frontend copy
 * 4. Run testFullCycleNow, testCoLPNow, testPoolSwaps for that chain
 *
 * Usage:
 *   node scripts/deployAndTestAll.js base|bnb|robinhood
 *   npm run deploy -- base
 *
 * Env: PRIVATE_KEY (required), <CHAIN>_RPC_URL or RPC_URL, and optionally
 *      MIN_THRESHOLD / KICK_BOND_MIN (normalized 18-dec units).
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

const CHAINS = {
    base: {
        script: 'DeployBase.s.sol:DeployBase',
        rpcEnv: 'BASE_RPC_URL', rpcFallback: 'https://mainnet.base.org',
        chainId: 8453, explorer: 'https://basescan.org',
        collateralKey: 'cbbtc',
    },
    bnb: {
        script: 'DeployBnb.s.sol:DeployBnb',
        rpcEnv: 'BSC_RPC_URL', rpcFallback: 'https://bsc-dataseed.bnbchain.org',
        chainId: 56, explorer: 'https://bscscan.com',
        collateralKey: 'qqqb',
    },
    robinhood: {
        script: 'DeployRobinhood.s.sol:DeployRobinhood',
        rpcEnv: 'ROBINHOOD_RPC_URL', rpcFallback: 'https://rpc.mainnet.chain.robinhood.com',
        chainId: 4663, explorer: 'https://robin.etherscan.io',
        collateralKey: 'spy',
    },
};

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

    const addr = {
        wsXMR: grab('wsXMR deployed to'),
        wsXmrHub: grab('wsXmrHub deployed to'),
        liquidityRouter: grab('Router deployed to'),
        VaultFacet: grab('VaultFacet deployed to'),
        MintFacet: grab('MintFacet deployed to'),
        BurnFacet: grab('BurnFacet deployed to'),
        LiquidationAuctionFacet: grab('LiquidationAuctionFacet deployed to'),
        CoLPFacet: grab('CoLPFacet deployed to'),
        pool: grab('wsXMR/\\S+ pool:\\s*(0x[0-9a-fA-F]{40})') || grab('Pool created') || grab('Pool already exists'),
    };

    // Also try the summary section
    if (!addr.wsXMR) addr.wsXMR = grab('wsXMR:');
    if (!addr.wsXmrHub) addr.wsXmrHub = grab('wsXmrHub:');
    if (!addr.liquidityRouter) addr.liquidityRouter = grab('LiquidityRouter:');
    if (!addr.VaultFacet) addr.VaultFacet = grab('VaultFacet:');
    if (!addr.MintFacet) addr.MintFacet = grab('MintFacet:');
    if (!addr.BurnFacet) addr.BurnFacet = grab('BurnFacet:');
    if (!addr.LiquidationAuctionFacet) addr.LiquidationAuctionFacet = grab('LiquidationAuction:');
    if (!addr.CoLPFacet) addr.CoLPFacet = grab('CoLPFacet:');
    if (!addr.pool) addr.pool = grab('wsXMR/\\S+ pool:');

    return addr;
}

// ── Write deployment.json ─────────────────────────────────────────────────────
function writeDeployment(chain, addr) {
    const deployerWallet = new (require('ethers').Wallet)(process.env.PRIVATE_KEY);

    const deployment = {
        network: chain,
        chainId: CHAINS[chain].chainId,
        deploymentDate: new Date().toISOString(),
        oracleFree: true,
        wsXMR: addr.wsXMR,
        wsXmrHub: addr.wsXmrHub,
        liquidityRouter: addr.liquidityRouter,
        pool: addr.pool,
        facets: {
            VaultFacet: addr.VaultFacet,
            MintFacet: addr.MintFacet,
            BurnFacet: addr.BurnFacet,
            LiquidationAuctionFacet: addr.LiquidationAuctionFacet,
            CoLPFacet: addr.CoLPFacet,
        },
        deployer: deployerWallet.address,
        explorer: CHAINS[chain].explorer,
        verification: { status: 'pending', verifiedContracts: [] },
    };

    const deployDir = path.join(__dirname, '..', 'deployments');
    fs.mkdirSync(deployDir, { recursive: true });
    const deployPath = path.join(deployDir, `${chain}-deployment.json`);
    const frontendPath = path.join(__dirname, '..', '..', 'frontend', `deployment.${chain}.json`);
    const json = JSON.stringify(deployment, null, 2) + '\n';
    fs.writeFileSync(deployPath, json);
    try { fs.writeFileSync(frontendPath, json); } catch (_) { /* frontend dir may differ */ }
    log(`✓ ${chain}-deployment.json written (deployments/ + frontend/)`, 'green');
    log(`  wsXMR:         ${addr.wsXMR}`, 'green');
    log(`  wsXmrHub:      ${addr.wsXmrHub}`, 'green');
    log(`  Router:        ${addr.liquidityRouter}`, 'green');
    log(`  Pool:          ${addr.pool}`, 'green');
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
    const t0 = Date.now();
    const chain = (process.argv[2] || '').toLowerCase();
    if (!CHAINS[chain]) {
        log('Usage: node scripts/deployAndTestAll.js base|bnb|robinhood', 'red');
        process.exit(1);
    }

    log('\n' + '█'.repeat(70), 'bright');
    log(`  WRAPSYNTH — DEPLOY + TEST (${chain.toUpperCase()}, oracle-free)`, 'bright');
    log('█'.repeat(70) + '\n', 'bright');

    const rpcUrl = process.env[CHAINS[chain].rpcEnv] || process.env.RPC_URL || CHAINS[chain].rpcFallback;
    if (!process.env.PRIVATE_KEY) {
        log('Missing env var: PRIVATE_KEY', 'red');
        process.exit(1);
    }
    log(`✓ Environment OK (rpc: ${rpcUrl})`, 'green');

    try {
        // ── Step 1: Deploy ────────────────────────────────────────────────────
        section(`STEP 1: Deploy contracts to ${chain}`);
        const forgeOutput = await runCmd('forge', [
            'script', `script/${CHAINS[chain].script}`,
            '--rpc-url', rpcUrl,
            '--broadcast', '--slow',
        ]);

        // ── Step 2: Parse + write deployment.json ─────────────────────────────
        section('STEP 2: Update deployment manifest');
        const addr = parseAddresses(forgeOutput);
        const missingAddr = Object.entries(addr).filter(([, v]) => !v).map(([k]) => k);
        if (missingAddr.length) {
            log(`⚠️  Could not parse: ${missingAddr.join(', ')}`, 'yellow');
            log('  You may need to manually update the deployment manifest', 'yellow');
        }
        writeDeployment(chain, addr);

        // ── Step 3: testFullCycleNow ──────────────────────────────────────────
        section('STEP 3: testFullCycleNow (mint + burn)');
        await runInherit('node', [`scripts/testFullCycleNow.${chain}.js`]);

        // ── Step 4: testCoLPNow ───────────────────────────────────────────────
        section('STEP 4: testCoLPNow (co-LP position)');
        await runInherit('node', [`scripts/testCoLPNow.${chain}.js`]);

        // ── Step 5: testPoolSwaps ─────────────────────────────────────────────
        section('STEP 5: testPoolSwaps (pool trading)');
        await runInherit('node', [`scripts/testPoolSwaps.${chain}.js`]);

        // ── Done ──────────────────────────────────────────────────────────────
        const dur = ((Date.now() - t0) / 1000).toFixed(1);
        section('ALL DONE');
        log(`✓ Deploy + tests completed in ${dur}s`, 'green');
        log('✓ Frontend and lp-server will pick up new addresses from the deployment manifest\n', 'green');
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
