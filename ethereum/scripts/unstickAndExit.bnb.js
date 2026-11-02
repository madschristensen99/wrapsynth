#!/usr/bin/env node
/**
 * Unstick the BNB vault's expired READY mint and exit collateral.
 *
 * The lpSecret for this mint was never persisted, so claimGriefingDeposit is
 * unavailable. Path (oracle-free — no price pushes needed anywhere):
 *
 *   Phase 1:
 *     cancelMint(rid, 0)            READY -> EXPIRED_READY, releases pendingDebt,
 *                                   starts the LP_CLAIM_WINDOW_BLOCKS timeout
 *     sweepUnclaimedExpiredMint     after the claim window: pendingMintCount--,
 *                                   slashes lockedCollateral -> pendingReturns[initiator]
 *     withdrawReturns(QQQB/0)       claims the slashed collateral + griefing deposit
 *
 *   Phase 2:
 *     withdrawCollateral            ~90% of free collateral (normalized units).
 *                                   No oracle freshness required — the
 *                                   oracle-free protocol never gates on price.
 *
 * Usage:
 *   node unstickAndExit.bnb.js            # full sequence
 *   node unstickAndExit.bnb.js --status   # print vault/mint state only
 *   node unstickAndExit.bnb.js --cancel   # phase 1 step 1 only
 *   node unstickAndExit.bnb.js --sweep    # wait for window, then sweep + claims
 *   node unstickAndExit.bnb.js --withdraw # withdraw ~90% of free collateral
 *
 * Env: PRIVATE_KEY (the LP vault owner), BSC_RPC_URL optional.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { ethers } = require('ethers');
const { HUB_ADDRESS, QQQB_ADDRESS, RPC_URL } = require('./deploymentConfig.bnb');

const REQUEST_ID = '0x0edbc2e9cc648747b2df503785aac006e09dde9a22e4d470fef95b5df23467a7';
const WITHDRAW_BPS = 9000n;              // withdraw ~90% of free collateral
const MINT_STATUS = ['INVALID','PENDING','KEY_PROVIDED','READY','SECRET_REVEALED','COMPLETED','CANCELLED','EXPIRED_READY','KEY_CANCELLED'];
const POLL_MS = 30_000;

const VAULT_TUPLE =
    'tuple(address lpAddress, uint256 collateralShares, uint256 lockedCollateral, ' +
    'uint256 normalizedDebt, uint256 pendingDebt, uint256 thresholdSharesPerWsxmr, ' +
    'uint256 maxMintWsxmr, uint256 mintGriefingDeposit, uint16 mintFeeBps, ' +
    'uint16 burnRewardBps, uint256 liquidationNonce, uint256 mintNonce, ' +
    'uint256 minBurnAmount, bool active, uint256 deployedCollateral, ' +
    'uint256 deployedWsxmr, uint16 maxCoLPRangeBps, uint256 mintTimeoutBlocks, ' +
    'uint256 burnTimeoutBlocks, uint256 pendingMintCount)';

const HUB_ABI = [
    'function cancelMint(bytes32 requestId, bytes32 userSecret) external',
    'function sweepUnclaimedExpiredMint(bytes32 requestId) external',
    'function getMintRequest(bytes32) view returns (tuple(bytes32 requestId, address initiator, address recipient, address lpVault, uint256 xmrAmount, uint256 wsxmrAmount, uint256 feeAmount, bytes32 claimCommitment, bytes32 userPublicKey, uint256 timeout, uint256 griefingDeposit, uint256 normalizedDebtAmount, uint256 vaultMintNonce, bytes32 lpCommitment, bytes32 revealedSecret, uint8 status, uint256 lockedCollateral, uint256 thresholdAtReady))',
    `function getVault(address) view returns (${VAULT_TUPLE})`,
    'function getPendingReturns(address user, address token) view returns (uint256)',
    'function withdrawReturns(address token) external',
    'function withdrawCollateral(uint256 amount) external',
];

const ZERO32 = '0x' + '0'.repeat(64);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function status(hub, wallet) {
    const [v, req, pendingColl, pendingNative, block] = await Promise.all([
        hub.getVault(wallet.address),
        hub.getMintRequest(REQUEST_ID),
        hub.getPendingReturns(wallet.address, QQQB_ADDRESS).catch(() => 0n),
        hub.getPendingReturns(wallet.address, ethers.constants.AddressZero).catch(() => 0n),
        hub.provider.getBlockNumber(),
    ]);
    console.log('── status ──────────────────────────────');
    console.log(`  block:              ${block}`);
    console.log(`  collateralShares:   ${ethers.utils.formatEther(v.collateralShares)} (normalized)`);
    console.log(`  lockedCollateral:   ${ethers.utils.formatEther(v.lockedCollateral)} (normalized)`);
    console.log(`  normalizedDebt:     ${ethers.utils.formatUnits(v.normalizedDebt, 8)} wsXMR`);
    console.log(`  pendingDebt:        ${ethers.utils.formatUnits(v.pendingDebt, 8)} wsXMR`);
    console.log(`  threshold/wsXMR:    ${ethers.utils.formatEther(v.thresholdSharesPerWsxmr)}`);
    console.log(`  pendingMintCount:   ${v.pendingMintCount}`);
    console.log(`  mint status:        ${MINT_STATUS[req.status]} (timeout block ${req.timeout})`);
    console.log(`  mint locked:        ${ethers.utils.formatEther(req.lockedCollateral)} (normalized)`);
    console.log(`  pendingReturns:     ${ethers.utils.formatEther(pendingColl)} QQQB, ${ethers.utils.formatEther(pendingNative)} BNB`);
    return { v, req, block };
}

async function waitForTimeout(hub, requestId) {
    for (;;) {
        const [req, block] = await Promise.all([hub.getMintRequest(requestId).catch(() => null), hub.provider.getBlockNumber()]);
        if (!req) { await sleep(POLL_MS); continue; }
        if (block >= req.timeout.toNumber()) return req;
        const eta = ((req.timeout.toNumber() - block) * 0.6 / 60).toFixed(1);
        console.log(`  waiting for claim window: ${req.timeout.toNumber() - block} blocks (~${eta} min)`);
        await sleep(POLL_MS);
    }
}

async function main() {
    if (!process.env.PRIVATE_KEY) { console.error('PRIVATE_KEY not set'); process.exit(1); }
    const args = new Set(process.argv.slice(2));

    const provider = new ethers.providers.JsonRpcProvider(RPC_URL);
    const floor = ethers.utils.parseUnits('0.1', 'gwei');
    provider.getFeeData = async () => ({
        gasPrice: floor, maxFeePerGas: floor, maxPriorityFeePerGas: floor, lastBaseFeePerGas: floor
    });
    const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
    const hub = new ethers.Contract(HUB_ADDRESS, HUB_ABI, wallet);

    console.log('signer:', wallet.address);

    const runAll = !args.size;
    const { req } = await status(hub, wallet);
    if (args.has('--status')) return;

    // ── Phase 1a: cancelMint (READY -> EXPIRED_READY) ────────────────────────
    if (runAll || args.has('--cancel')) {
        if (req.status === 3) {
            const cur = await hub.provider.getBlockNumber();
            if (cur < req.timeout.toNumber()) throw new Error(`mint timeout not reached: block ${cur} < ${req.timeout}`);
            console.log('\nsending cancelMint...');
            const tx = await hub.cancelMint(REQUEST_ID, ZERO32);
            console.log('  tx:', tx.hash);
            await tx.wait();
            console.log('  EXPIRED_READY — pendingDebt released, claim window started');
        } else {
            console.log(`\nmint already ${MINT_STATUS[req.status]} — skipping cancelMint`);
        }
    }
    if (args.has('--cancel')) return;

    // ── Phase 1b: sweep after the claim window ───────────────────────────────
    if (runAll || args.has('--sweep')) {
        let r = await hub.getMintRequest(REQUEST_ID);
        if (r.status === 7) { // EXPIRED_READY
            r = await waitForTimeout(hub, REQUEST_ID);
            console.log('\nsending sweepUnclaimedExpiredMint...');
            const tx = await hub.sweepUnclaimedExpiredMint(REQUEST_ID);
            console.log('  tx:', tx.hash);
            await tx.wait();
            console.log('  swept — pendingMintCount cleared, collateral queued to pendingReturns');
        } else {
            console.log(`\nmint is ${MINT_STATUS[r.status]}, sweep not applicable`);
        }

        // Claim whatever landed in pendingReturns
        for (const [token, label] of [[QQQB_ADDRESS, 'QQQB'], [ethers.constants.AddressZero, 'BNB']]) {
            const amt = await hub.getPendingReturns(wallet.address, token);
            if (amt.gt(0)) {
                const tx = await hub.withdrawReturns(token);
                console.log(`  withdrawReturns(${label}): ${tx.hash}`);
                await tx.wait();
            }
        }
    }
    if (args.has('--sweep')) return;

    // ── Phase 2: withdraw ~90% of free collateral ────────────────────────────
    if (runAll || args.has('--withdraw')) {
        const v = await hub.getVault(wallet.address);
        if (v.pendingMintCount.gt(0)) throw new Error('pendingMintCount still > 0 — run --sweep first');

        const avail = v.collateralShares.sub(v.lockedCollateral);
        const shares = avail.mul(Number(WITHDRAW_BPS)).div(10000);
        if (shares.gt(0)) {
            console.log(`withdrawing ${ethers.utils.formatEther(shares)} normalized units (~90%)...`);
            const wTx = await hub.withdrawCollateral(shares);
            console.log('  tx:', wTx.hash);
            await wTx.wait();
            console.log('  withdrawn.');
        }

        await status(hub, wallet);
    }
    if (args.has('--withdraw')) return;
}

main().catch(e => { console.error('failed:', e.message || e); process.exit(1); });
