#!/usr/bin/env node
/**
 * Test FULL mint and burn cycle on Base mainnet.
 * Vault setup (cbBTC collateral) -> mint wsXMR -> burn wsXMR.
 * All transactions hit the live deployment — visible on BaseScan.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { ethers } = require('ethers');
const { WrapperBuilder } = require('@redstone-finance/evm-connector');
const { getSignersForDataServiceId } = require('@redstone-finance/oracles-smartweave-contracts');
const { HUB_ADDRESS, WSXMR_ADDRESS, QQQB_ADDRESS, STATA_ADDRESS, ED25519_HELPER, RPC_URL, EXPLORER } = require('./deploymentConfig.base');
const { redstoneGatewayUrls } = require('./redstoneGateway');

function wrapWithRedStone(contract) {
    const authorizedSigners = getSignersForDataServiceId('redstone-primary-prod');
    return WrapperBuilder.wrap(contract).usingDataService({
        dataServiceId: 'redstone-primary-prod',
        uniqueSignersCount: 3,
        dataPackagesIds: ['XMR'], // Base collateral price is on-chain TWAP, not a pushed feed
        authorizedSigners,
        urls: redstoneGatewayUrls()
    });
}

async function retryRedStone(fn, maxRetries = 3) {
    let lastError;
    for (let i = 0; i < maxRetries; i++) {
        try {
            return await fn();
        } catch (err) {
            lastError = err;
            const isTimeout = err.message && (
                err.message.includes('timeout') ||
                err.message.includes('AggregateError') ||
                err.message.includes('ETIMEDOUT')
            );
            if (!isTimeout || i === maxRetries - 1) throw err;
            const delay = 2000 * Math.pow(2, i);
            console.log(`  RedStone timeout, retrying in ${delay / 1000}s... (attempt ${i + 2}/${maxRetries})`);
            await new Promise(r => setTimeout(r, delay));
        }
    }
    throw lastError;
}

// Push only when prices are stale — a second push with the same RedStone
// datapoint timestamp reverts (payload must be strictly newer).
async function pushFresh(hub) {
    try {
        await hub.getXmrPrice();
        console.log('  Prices already fresh — skipping push');
        return null;
    } catch (e) {}
    const tx = await retryRedStone(() => wrapWithRedStone(hub).updateOraclePrices([]));
    await tx.wait();
    console.log('  Prices updated:', tx.hash);
    return tx;
}

async function main() {
    if (!process.env.PRIVATE_KEY) {
        console.error('PRIVATE_KEY environment variable not set');
        process.exit(1);
    }

    const provider = new ethers.providers.JsonRpcProvider(RPC_URL);
    const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

    console.log('Testing FULL Mint and Burn Cycle — Base');
    console.log('=========================================');
    console.log('Wallet:', wallet.address);
    console.log('Hub:', HUB_ADDRESS);
    console.log('');

    const hubAbi = [
        'function createVault() external',
        'function depositCollateral(uint256 amount) external',
        'function hasActiveVault(address lpAddress) external view returns (bool)',
        'function getVault(address lpAddress) external view returns (tuple(address lpAddress, uint256 collateralShares, uint256 lockedCollateral, uint256 normalizedDebt, uint256 pendingDebt, uint16 maxMintBps, uint256 mintGriefingDeposit, uint16 mintFeeBps, uint16 burnRewardBps, uint256 liquidationNonce, uint256 mintNonce, uint256 minBurnAmount, bool active, uint256 deployedSDAIShares, uint16 maxCoLPRangeBps, uint256 mintTimeoutBlocks, uint256 burnTimeoutBlocks, uint256 pendingMintCount))',
        'function setMaxMintBps(uint16 maxMintBps) external',
        'function setMinBurnAmount(uint256 minAmount) external',
        'function setMintGriefingDeposit(uint256 deposit) external',
        'function setVaultMarketMetrics(uint16 mintFeeBps, uint16 burnRewardBps) external',
        'function setMaxCoLPRange(uint16 newMaxBps) external',
        'function initiateMint(address lpVault, address initiator, uint256 wsxmrAmount, bytes32 claimCommitment, bytes32 userPublicKey) external payable returns (bytes32)',
        'function provideLPKey(bytes32 requestId, bytes32 lpPublicSpendKey, bytes32 lpPublicViewKey, bytes32 lpCommitment) external',
        'function setMintReady(bytes32 requestId) external',
        'function revealSecret(bytes32 requestId, bytes32 secret) external',
        'function finalizeMint(bytes32 requestId) external',
        'function requestBurn(uint256 wsxmrAmount, address lpVault, address burnRecipient, bytes32 claimCommitment, bytes32 userPublicKey, bytes32 userViewKey) external returns (bytes32)',
        'function proposeHash(bytes32 requestId, bytes32 secretHash, bytes32 lpPublicSpendKey, bytes32 lpPublicViewKey) external',
        'function confirmMoneroLock(bytes32 requestId) external',
        'function finalizeBurn(bytes32 requestId, bytes32 secret) external',
        'function updateOraclePrices(bytes[] calldata updateData) external payable',
        'function getXmrPrice() external view returns (uint256)'
    ];

    const erc20Abi = [
        'function balanceOf(address) external view returns (uint256)',
        'function approve(address spender, uint256 amount) external returns (bool)',
        'function decimals() external view returns (uint8)',
        'function symbol() external view returns (string)',
        'function totalSupply() external view returns (uint256)'
    ];

    const ed25519HelperAbi = [
        'function computeCommitment(bytes32 secret) external view returns (bytes32)',
        'function scalarMultBase(uint256 scalar) external view returns (uint256 x, uint256 y)',
        'function compressPublicKey(uint256 px, uint256 py) external pure returns (uint256)'
    ];

    const hub = new ethers.Contract(HUB_ADDRESS, hubAbi, wallet);
    const wsxmr = new ethers.Contract(WSXMR_ADDRESS, erc20Abi, wallet);
    const cbbtc = new ethers.Contract(QQQB_ADDRESS, erc20Abi, wallet);
    const ed25519Helper = new ethers.Contract(ED25519_HELPER, ed25519HelperAbi, provider);

    // --- STEP 0: Vault ---
    const hasVault = await hub.hasActiveVault(wallet.address);
    const collateralAmount = ethers.utils.parseUnits('0.0005', 8); // 0.0005 cbBTC ~ $40

    if (!hasVault) {
        console.log('Step 0: Creating Vault + depositing cbBTC collateral');
        await (await hub.createVault()).wait();
        console.log('  Vault created');

        await (await hub.setMaxMintBps(0)).wait();
        await (await hub.setMinBurnAmount(0)).wait();
        await (await hub.setMintGriefingDeposit(ethers.utils.parseEther('0.0002'))).wait(); // 0.0002 ETH
        await (await hub.setVaultMarketMetrics(50, 30)).wait(); // 0.5% mint fee, 0.3% burn reward
        await (await hub.setMaxCoLPRange(2500)).wait();
        console.log('  Vault configured (0.5% mint fee, 0.3% burn reward, 0.0002 ETH griefing, 2500bps co-LP range)');
    } else {
        console.log('  Vault already exists');
        await (await hub.setVaultMarketMetrics(50, 30)).wait();
        console.log('  Vault config refreshed');
    }

    const vault = await hub.getVault(wallet.address);
    console.log('  Collateral shares:', ethers.utils.formatUnits(vault.collateralShares, 8));
    if (vault.collateralShares.eq(0)) {
        const cbbtcBalance = await cbbtc.balanceOf(wallet.address);
        console.log('  Wallet cbBTC:', ethers.utils.formatUnits(cbbtcBalance, 8));
        if (cbbtcBalance.eq(0)) {
            console.error('  No cbBTC for collateral deposit — fund the wallet first');
            process.exit(1);
        }
        const depositAmt = cbbtcBalance.lt(collateralAmount) ? cbbtcBalance : collateralAmount;
        await (await cbbtc.approve(HUB_ADDRESS, depositAmt)).wait();
        await (await hub.depositCollateral(depositAmt)).wait();
        console.log('  Deposited', ethers.utils.formatUnits(depositAmt, 8), 'cbBTC');
    }
    console.log('');

    // --- STEP 1: Update prices ---
    console.log('Step 1: Push RedStone XMR price (+ on-chain cbBTC TWAP refresh)');
    await pushFresh(hub);
    console.log('');

    // --- STEP 2: MINT ---
    console.log('Step 2: MINT — initiate');
    const xmrAmount = ethers.BigNumber.from('200000000'); // 0.002 XMR -> 20000 wsXMR units
    const expectedWsXmr = xmrAmount.div(10000);
    console.log('  Expected wsXMR:', ethers.utils.formatUnits(expectedWsXmr, 8));

    const secret = ethers.utils.randomBytes(32);
    const claimCommitment = await ed25519Helper.computeCommitment(secret);
    const [userPubX, userPubY] = await ed25519Helper.scalarMultBase(ethers.BigNumber.from(secret));
    const compressed = await ed25519Helper.compressPublicKey(userPubX, userPubY);
    const userPublicKey = ethers.utils.hexZeroPad(compressed.toHexString(), 32);
    const griefingDeposit = ethers.utils.parseEther('0.0002');

    console.log('  Refreshing prices before mint (120s staleness window)...');
    await pushFresh(hub);

    const mintTx = await hub.initiateMint(
        wallet.address, wallet.address, xmrAmount, claimCommitment, userPublicKey,
        { value: griefingDeposit, gasLimit: 800000 }
    );
    const mintReceipt = await mintTx.wait();
    const requestId = mintReceipt.logs[0].topics[1];
    console.log('  Mint initiated:', mintTx.hash);
    console.log('  Request ID:', requestId);
    console.log('');

    console.log('Step 3: MINT — LP provides public key');
    await pushFresh(hub);

    const lpSecret = ethers.utils.randomBytes(32);
    const [lpPubX, lpPubY] = await ed25519Helper.scalarMultBase(ethers.BigNumber.from(lpSecret));
    const lpPublicKey = ethers.utils.keccak256(ethers.utils.defaultAbiCoder.encode(['uint256', 'uint256'], [lpPubX, lpPubY]));
    const lpCommitment = lpPublicKey;

    await (await hub.provideLPKey(requestId, lpPublicKey, lpPublicKey, lpCommitment)).wait();
    console.log('  LP key provided');
    await (await hub.setMintReady(requestId)).wait();
    console.log('  Mint marked ready');
    console.log('');

    console.log('Step 4: MINT — reveal + finalize');
    await (await hub.revealSecret(requestId, secret, { gasLimit: 800000 })).wait();
    console.log('  Secret revealed');
    const finalizeTx = await hub.finalizeMint(requestId, { gasLimit: 800000 });
    const finalizeReceipt = await finalizeTx.wait();
    console.log('  Mint finalized:', finalizeTx.hash, 'gas:', finalizeReceipt.gasUsed.toString());

    const decimals = await wsxmr.decimals();
    const wsxmrBalance = await wsxmr.balanceOf(wallet.address);
    const expectedAfterFee = expectedWsXmr.sub(expectedWsXmr.mul(50).div(10000));
    console.log('  wsXMR balance:', ethers.utils.formatUnits(wsxmrBalance, decimals),
        '(expected ~', ethers.utils.formatUnits(expectedAfterFee, decimals), 'after 0.5% fee)');
    console.log('');

    // --- STEP 5: BURN ---
    console.log('Step 5: BURN — request');
    await pushFresh(hub);

    const burnAmount = wsxmrBalance;
    await (await wsxmr.approve(HUB_ADDRESS, burnAmount)).wait();

    const dummyCommitment = ethers.utils.id('test-burn');
    const burnRequestId = await hub.callStatic.requestBurn(
        burnAmount, wallet.address, wallet.address, dummyCommitment, ethers.utils.id('pub'), ethers.utils.id('view')
    );
    const burnTx = await hub.requestBurn(
        burnAmount, wallet.address, wallet.address, dummyCommitment, ethers.utils.id('pub'), ethers.utils.id('view')
    );
    await burnTx.wait();
    console.log('  Burn requested:', burnTx.hash);
    console.log('  Request ID:', burnRequestId);
    console.log('  Amount:', ethers.utils.formatUnits(burnAmount, decimals), 'wsXMR');
    console.log('');

    console.log('Step 6: BURN — LP proposes secret hash');
    const burnSecret = ethers.utils.randomBytes(32);
    const secretHash = await ed25519Helper.computeCommitment(burnSecret);
    const [burnLpPubX, burnLpPubY] = await ed25519Helper.scalarMultBase(ethers.BigNumber.from(burnSecret));
    const burnLpSpendKey = ethers.utils.hexZeroPad(ethers.BigNumber.from(burnLpPubX).toHexString(), 32);
    const burnLpViewKey = ethers.utils.hexZeroPad(ethers.BigNumber.from(burnLpPubY).toHexString(), 32);

    await (await hub.proposeHash(burnRequestId, secretHash, burnLpSpendKey, burnLpViewKey)).wait();
    console.log('  Secret hash proposed');
    console.log('');

    console.log('Step 7: BURN — user confirms Monero lock (simulated)');
    await (await hub.confirmMoneroLock(burnRequestId, { gasLimit: 500000 })).wait();
    console.log('  Monero lock confirmed');
    console.log('');

    console.log('Step 8: BURN — LP finalizes');
    const finalizeBurnTx = await hub.finalizeBurn(burnRequestId, burnSecret, { gasLimit: 800000 });
    const finalizeBurnReceipt = await finalizeBurnTx.wait();
    console.log('  Burn finalized:', finalizeBurnTx.hash, 'gas:', finalizeBurnReceipt.gasUsed.toString());

    const finalBalance = await wsxmr.balanceOf(wallet.address);
    const totalSupply = await wsxmr.totalSupply();
    console.log('  Final wsXMR balance:', ethers.utils.formatUnits(finalBalance, decimals));
    console.log('  Total supply:', ethers.utils.formatUnits(totalSupply, decimals));
    console.log('');

    console.log('FULL CYCLE COMPLETE');
    console.log(EXPLORER + '/address/' + wallet.address);
}

main().catch(err => { console.error(err); process.exit(1); });
