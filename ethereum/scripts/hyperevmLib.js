#!/usr/bin/env node
/**
 * Shared helpers for the HyperEVM mainnet test scripts.
 * - refreshPrices: poke the HyperCore oracle (free, permissionless)
 * - ensureUSDe: auto-buy USDe by wrapping HYPE->WHYPE and swapping on HyperSwap
 * - ensureVault: create + configure + collateralize the LP vault
 * - mintWsXMR: self-driven mint (Ed25519 keys, dummy commitments — no real XMR tx)
 */

const { ethers } = require('ethers');
const cfg = require('./deploymentConfig.hyperevm');

const WHYPE = '0x5555555555555555555555555555555555555555'; // wrapped HYPE
const USDE_BUY_FEE = 3000; // WHYPE/USDe 0.3% pool (deepest liquidity)

const ERC20 = [
    'function balanceOf(address) external view returns (uint256)',
    'function approve(address spender, uint256 amount) external returns (bool)',
    'function decimals() external view returns (uint8)',
    'function symbol() external view returns (string)'
];
const WHYPE_ABI = ERC20.concat(['function deposit() external payable', 'function withdraw(uint256) external']);
// HyperSwap SwapRouter02 — NON-STANDARD 7-field params (no deadline)
const ROUTER_ABI = [
    'function exactInputSingle(tuple(address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) external payable returns (uint256 amountOut)'
];
const ED25519_ABI = [
    'function computeCommitment(bytes32 secret) external view returns (bytes32)',
    'function scalarMultBase(uint256 scalar) external view returns (uint256 x, uint256 y)',
    'function compressPublicKey(uint256 px, uint256 py) external pure returns (uint256)'
];
const HUB_ABI = [
    'function createVault() external',
    'function depositCollateral(uint256 amount) external',
    'function hasActiveVault(address) external view returns (bool)',
    'function getVault(address) external view returns (tuple(address lpAddress, uint256 collateralShares, uint256 lockedCollateral, uint256 normalizedDebt, uint256 pendingDebt, uint16 maxMintBps, uint256 mintGriefingDeposit, uint16 mintFeeBps, uint16 burnRewardBps, uint256 liquidationNonce, uint256 mintNonce, uint256 minBurnAmount, bool active, uint256 deployedSDAIShares, uint16 maxCoLPRangeBps, uint256 mintTimeoutBlocks, uint256 burnTimeoutBlocks, uint256 pendingMintCount))',
    'function setMaxMintBps(uint16) external',
    'function setMinBurnAmount(uint256) external',
    'function setMintGriefingDeposit(uint256) external',
    'function setVaultMarketMetrics(uint16, uint16) external',
    'function setMaxCoLPRange(uint16) external',
    'function getCoLPCapacity(address) external view returns (uint256)',
    'function userOpenCoLP(address lpVault, uint256 wsxmrAmount, uint256 deadline) external returns (uint256)',
    'function unwindCoLP(uint256 tokenId, uint256 deadline) external',
    'function collectCoLPFees(uint256 tokenId) external',
    'function getPendingReturns(address user, address token) external view returns (uint256)',
    'function withdrawReturns(address token) external',
    'function withdrawCollateral(uint256 amount) external',
    'function liquidityRouter() external view returns (address)',
    'function initiateMint(address lpVault, address initiator, uint256 wsxmrAmount, bytes32 claimCommitment, bytes32 userPublicKey) external payable returns (bytes32)',
    'function provideLPKey(bytes32 requestId, bytes32 lpPublicSpendKey, bytes32 lpPublicViewKey, bytes32 lpCommitment) external',
    'function setMintReady(bytes32 requestId) external',
    'function revealSecret(bytes32 requestId, bytes32 secret) external',
    'function finalizeMint(bytes32 requestId) external',
    'function mintRequests(bytes32) external view returns (tuple(bytes32 requestId, address initiator, address recipient, address lpVault, uint256 xmrAmount, uint256 wsxmrAmount, uint256 feeAmount, bytes32 claimCommitment, bytes32 userPublicKey, uint256 timeout, uint256 griefingDeposit, uint256 normalizedDebtAmount, uint256 vaultMintNonce, bytes32 lpCommitment, bytes32 revealedSecret, uint8 status, uint256 lockedCollateral, uint256 xmrPriceAtReady))',
    'function requestBurn(uint256 wsxmrAmount, address lpVault, address burnRecipient, bytes32 claimCommitment, bytes32 userPublicKey, bytes32 userViewKey) external returns (bytes32)',
    'function proposeHash(bytes32 requestId, bytes32 secretHash, bytes32 lpPublicSpendKey, bytes32 lpPublicViewKey) external',
    'function confirmMoneroLock(bytes32 requestId) external',
    'function finalizeBurn(bytes32 requestId, bytes32 secret) external',
    'function refreshPrices() external',
    'event CoLPDeployed(address indexed lpVault, address indexed user, uint256 indexed tokenId, uint256 sDAIShares, uint256 wsxmrAmount, uint16 rangeBps)'
];

function getWallet() {
    if (!process.env.PRIVATE_KEY) { console.error('PRIVATE_KEY not set'); process.exit(1); }
    const provider = new ethers.providers.JsonRpcProvider(cfg.RPC_URL);
    return { provider, wallet: new ethers.Wallet(process.env.PRIVATE_KEY, provider) };
}

function getContracts(wallet, provider) {
    return {
        hub: new ethers.Contract(cfg.HUB_ADDRESS, HUB_ABI, wallet),
        wsxmr: new ethers.Contract(cfg.WSXMR_ADDRESS, ERC20, wallet),
        usde: new ethers.Contract(cfg.USDE_ADDRESS, ERC20, wallet),
        whype: new ethers.Contract(WHYPE, WHYPE_ABI, wallet),
        router: new ethers.Contract(cfg.HYPERSWAP_ROUTER, ROUTER_ABI, wallet),
        ed25519: new ethers.Contract(cfg.ED25519_HELPER, ED25519_ABI, provider)
    };
}

async function refreshPrices(hub) {
    const tx = await hub.refreshPrices({ gasLimit: 500000 });
    await tx.wait();
    return tx;
}

// Send a tx, wait for the receipt, and throw on status 0 (revert). ethers v5
// .wait() resolves with the receipt even on revert, so we must check status.
async function send(txPromise, label = 'tx') {
    const tx = await txPromise;
    const rc = await tx.wait();
    if (rc.status !== 1) throw new Error(`${label} reverted on-chain: ${rc.transactionHash}`);
    return rc;
}

// HyperEVM quirk: a tx's receipt confirms before its state is queryable, so a
// dependent tx's estimateGas/callStatic reads stale state and reverts. Retry the
// tx until the prior state has propagated (each retry re-estimates gas fresh).
async function sendRetry(txFn, label = 'tx', retries = 12, delayMs = 1500) {
    let lastErr;
    for (let i = 0; i < retries; i++) {
        try { return await send(txFn(), label); }
        catch (e) { lastErr = e; if (i < retries - 1) await new Promise(r => setTimeout(r, delayMs)); }
    }
    throw lastErr;
}

// Poll a read condition until it reflects propagated state (or time out).
async function waitFor(fn, timeoutMs = 30000, intervalMs = 400) {
    const start = Date.now();
    for (;;) {
        try { if (await fn()) return; } catch (e) { /* keep polling */ }
        if (Date.now() - start > timeoutMs) throw new Error('waitFor: state did not propagate in time');
        await new Promise(r => setTimeout(r, intervalMs));
    }
}

// Buy `needed` USDe with HYPE if the wallet is short. Wraps HYPE->WHYPE then
// swaps WHYPE->USDe on the HyperSwap router (7-field exactInputSingle).
async function ensureUSDe(wallet, c, needed) {
    const bal = await c.usde.balanceOf(wallet.address);
    if (bal.gte(needed)) return bal;

    const shortfall = needed.sub(bal);
    // Estimate HYPE needed: USDe ~ $1, HYPE ~ $40 -> over-provision 2x for slippage.
    // Simpler: swap a fixed HYPE amount sized to cover the shortfall with margin.
    const hypePriceUsd = 40; // conservative; adjust if HYPE moves a lot
    const usdeNeeded = parseFloat(ethers.utils.formatEther(shortfall));
    const hypeNeeded = (usdeNeeded / hypePriceUsd) * 2.0; // 2x margin
    const hypeIn = ethers.utils.parseEther(Math.max(hypeNeeded, 0.005).toFixed(6));

    const hypeBal = await wallet.getBalance();
    const reserve = ethers.utils.parseEther('0.01'); // keep gas
    if (hypeBal.sub(reserve).lt(hypeIn)) {
        console.log(`  Not enough HYPE to buy USDe (have ${ethers.utils.formatEther(hypeBal)}, need ~${ethers.utils.formatEther(hypeIn)} + gas)`);
        return bal;
    }

    console.log(`  Buying USDe: wrapping ${ethers.utils.formatEther(hypeIn)} HYPE -> WHYPE -> USDe`);
    await send(c.whype.deposit({ value: hypeIn }), 'whype.deposit');
    await sendRetry(() => c.whype.approve(cfg.HYPERSWAP_ROUTER, hypeIn), 'whype.approve');
    await sendRetry(() => c.router.exactInputSingle({
        tokenIn: WHYPE,
        tokenOut: cfg.USDE_ADDRESS,
        fee: USDE_BUY_FEE,
        recipient: wallet.address,
        amountIn: hypeIn,
        amountOutMinimum: 0,
        sqrtPriceLimitX96: 0
    }, { gasLimit: 800000 }), 'swap WHYPE->USDe');
    const newBal = await c.usde.balanceOf(wallet.address);
    console.log(`  USDe balance now: ${ethers.utils.formatEther(newBal)}`);
    return newBal;
}

// Create + configure the vault and ensure `collateral` USDe is deposited.
async function ensureVault(wallet, c, collateral) {
    const hasVault = await c.hub.hasActiveVault(wallet.address);
    if (!hasVault) {
        console.log('Creating vault...');
        await send(c.hub.createVault({ gasLimit: 300000 }), 'createVault');
        await sendRetry(() => c.hub.setMaxMintBps(0, { gasLimit: 200000 }), 'setMaxMintBps');
        await sendRetry(() => c.hub.setMinBurnAmount(0, { gasLimit: 200000 }), 'setMinBurnAmount');
        await sendRetry(() => c.hub.setMintGriefingDeposit(ethers.utils.parseEther('0.001'), { gasLimit: 200000 }), 'setMintGriefingDeposit');
        await sendRetry(() => c.hub.setVaultMarketMetrics(50, 30, { gasLimit: 200000 }), 'setVaultMarketMetrics');
        await sendRetry(() => c.hub.setMaxCoLPRange(2500, { gasLimit: 200000 }), 'setMaxCoLPRange');
        console.log('Vault created + configured');
    }

    const vault = await c.hub.getVault(wallet.address);
    const idle = vault.collateralShares.gt(vault.lockedCollateral)
        ? vault.collateralShares.sub(vault.lockedCollateral) : ethers.BigNumber.from(0);
    if (idle.lt(collateral)) {
        await ensureUSDe(wallet, c, collateral);
        const usdeBal = await c.usde.balanceOf(wallet.address);
        const toDeposit = usdeBal.lt(collateral) ? usdeBal : collateral;
        if (toDeposit.gt(0)) {
            await send(c.usde.approve(cfg.HUB_ADDRESS, toDeposit), 'usde.approve');
            await sendRetry(() => c.hub.depositCollateral(toDeposit, { gasLimit: 1500000 }), 'depositCollateral');
            console.log('Deposited', ethers.utils.formatEther(toDeposit), 'USDe collateral');
        }
    }
}

// Self-driven mint: user+LP are the same wallet; Ed25519 keys via the helper.
async function mintWsXMR(wallet, c, xmrAmount) {
    await refreshPrices(c.hub);
    const secret = ethers.utils.randomBytes(32);
    const commitment = await c.ed25519.computeCommitment(secret);
    const [px, py] = await c.ed25519.scalarMultBase(ethers.BigNumber.from(secret));
    const compressed = await c.ed25519.compressPublicKey(px, py);
    const userPublicKey = ethers.utils.hexZeroPad(compressed.toHexString(), 32);
    const griefingDeposit = ethers.utils.parseEther('0.001');

    await refreshPrices(c.hub);
    const mintReceipt = await send(c.hub.initiateMint(wallet.address, wallet.address, xmrAmount, commitment, userPublicKey, { value: griefingDeposit, gasLimit: 1000000 }), 'initiateMint');
    const requestId = mintReceipt.logs[0].topics[1];

    await refreshPrices(c.hub);
    const lpSecret = ethers.utils.randomBytes(32);
    const [lx, ly] = await c.ed25519.scalarMultBase(ethers.BigNumber.from(lpSecret));
    const lpPublicKey = ethers.utils.keccak256(ethers.utils.defaultAbiCoder.encode(['uint256', 'uint256'], [lx, ly]));
    const lpCommitment = ethers.utils.keccak256(ethers.utils.defaultAbiCoder.encode(['uint256', 'uint256'], [lx, ly]));
    await sendRetry(() => c.hub.provideLPKey(requestId, lpPublicKey, lpPublicKey, lpCommitment, { gasLimit: 500000 }), 'provideLPKey');
    await sendRetry(() => c.hub.setMintReady(requestId, { gasLimit: 500000 }), 'setMintReady');
    await sendRetry(() => c.hub.revealSecret(requestId, secret, { gasLimit: 1000000 }), 'revealSecret');
    await sendRetry(() => c.hub.finalizeMint(requestId, { gasLimit: 1000000 }), 'finalizeMint');
    return requestId;
}

module.exports = { getWallet, getContracts, refreshPrices, ensureUSDe, ensureVault, mintWsXMR, send, sendRetry, waitFor, WHYPE, ERC20, HUB_ABI, ED25519_ABI, cfg };
