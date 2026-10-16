#!/usr/bin/env node
/**
 * Test Co-LP positions on BNB Chain mainnet.
 * Opens a real co-LP position against the wsXMR/QQQB pool and unwinds it.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { ethers } = require('ethers');
const { WrapperBuilder } = require('@redstone-finance/evm-connector');
const { getSignersForDataServiceId } = require('@redstone-finance/oracles-smartweave-contracts');
const { HUB_ADDRESS, WSXMR_ADDRESS, QQQB_ADDRESS, ED25519_HELPER, RPC_URL } = require('./deploymentConfig.bnb');

async function retryRedStone(fn, maxRetries = 3) {
    let lastError;
    for (let i = 0; i < maxRetries; i++) {
        try { return await fn(); } catch (err) {
            lastError = err;
            const isTimeout = err.message && (err.message.includes('timeout') || err.message.includes('AggregateError') || err.message.includes('ETIMEDOUT'));
            if (!isTimeout || i === maxRetries - 1) throw err;
            const delay = 2000 * Math.pow(2, i);
            console.log(`  RedStone timeout, retrying in ${delay / 1000}s... (attempt ${i + 2}/${maxRetries})`);
            await new Promise(r => setTimeout(r, delay));
        }
    }
    throw lastError;
}

async function main() {
    if (!process.env.PRIVATE_KEY) {
        console.error('PRIVATE_KEY environment variable not set');
        process.exit(1);
    }

    const provider = new ethers.providers.JsonRpcProvider(RPC_URL);
    // Pin fees to the BSC floor — this RPC over-reports fee data (1.5 gwei vs 0.05 actual)
    const floor = ethers.utils.parseUnits('0.1', 'gwei');
    provider.getFeeData = async () => ({
        gasPrice: floor, maxFeePerGas: floor, maxPriorityFeePerGas: floor, lastBaseFeePerGas: floor
    });
    const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

    console.log('Co-LP Test — BNB Chain');
    console.log('======================');
    console.log('Wallet:', wallet.address);
    console.log('');

    const hubAbi = [
        'function createVault() external',
        'function depositCollateral(uint256 amount) external',
        'function hasActiveVault(address lpAddress) external view returns (bool)',
        'function getVault(address lpAddress) external view returns (tuple(address lpAddress, uint256 collateralShares, uint256 lockedCollateral, uint256 normalizedDebt, uint256 pendingDebt, uint16 maxMintBps, uint256 mintGriefingDeposit, uint16 mintFeeBps, uint16 burnRewardBps, uint256 liquidationNonce, uint256 mintNonce, uint256 minBurnAmount, bool active, uint256 deployedSDAIShares, uint16 maxCoLPRangeBps, uint256 mintTimeoutBlocks, uint256 burnTimeoutBlocks, uint256 pendingMintCount))',
        'function setMaxMintBps(uint16) external',
        'function setMinBurnAmount(uint256) external',
        'function setMintGriefingDeposit(uint256) external',
        'function setVaultMarketMetrics(uint16, uint16) external',
        'function setMaxCoLPRange(uint16) external',
        'function userOpenCoLP(address lpVault, uint256 wsxmrAmount, uint256 deadline) external returns (uint256 tokenId)',
        'function unwindCoLP(uint256 tokenId, uint256 deadline) external',
        'function collectCoLPFees(uint256 tokenId) external',
        'function getCoLPCapacity(address lpVault) external view returns (uint256)',
        'function liquidityRouter() external view returns (address)',
        'function getPendingReturns(address user, address token) external view returns (uint256)',
        'function withdrawReturns(address token) external',
        'function initiateMint(address lpVault, address initiator, uint256 wsxmrAmount, bytes32 claimCommitment, bytes32 userPublicKey) external payable returns (bytes32)',
        'function provideLPKey(bytes32 requestId, bytes32 lpPublicSpendKey, bytes32 lpPublicViewKey, bytes32 lpCommitment) external',
        'function setMintReady(bytes32 requestId) external',
        'function revealSecret(bytes32 requestId, bytes32 secret) external',
        'function finalizeMint(bytes32 requestId) external',
        'function updateOraclePrices(bytes[] calldata updateData) external payable',
        'event CoLPDeployed(address indexed lpVault, address indexed user, uint256 indexed tokenId, uint256 sDAIShares, uint256 wsxmrAmount, uint16 rangeBps)',
        'event CoLPUnwound(uint256 indexed tokenId, address indexed vaultOwner, address indexed user, uint256 sDAIReturned, uint256 wsxmrReturned)'
    ];

    const erc20Abi = [
        'function balanceOf(address) external view returns (uint256)',
        'function approve(address spender, uint256 amount) external returns (bool)',
        'function decimals() external view returns (uint8)'
    ];

    const ed25519HelperAbi = [
        'function computeCommitment(bytes32 secret) external view returns (bytes32)',
        'function scalarMultBase(uint256 scalar) external view returns (uint256 x, uint256 y)',
        'function compressPublicKey(uint256 px, uint256 py) external pure returns (uint256)'
    ];

    const hub = new ethers.Contract(HUB_ADDRESS, hubAbi, wallet);
    const wsxmr = new ethers.Contract(WSXMR_ADDRESS, erc20Abi, wallet);
    const qqqb = new ethers.Contract(QQQB_ADDRESS, erc20Abi, wallet);
    const ed25519Helper = new ethers.Contract(ED25519_HELPER, ed25519HelperAbi, provider);

    const authorizedSigners = getSignersForDataServiceId('redstone-primary-prod');
    const wrappedHub = WrapperBuilder.wrap(hub).usingDataService({
        dataServiceId: 'redstone-primary-prod',
        uniqueSignersCount: 3,
        dataPackagesIds: ['XMR'],
        authorizedSigners
    });

    console.log('Hub liquidityRouter:', await hub.liquidityRouter());

    // --- Vault ---
    if (!(await hub.hasActiveVault(wallet.address))) {
        console.log('Creating vault...');
        await (await hub.createVault()).wait();
        await (await hub.setMaxMintBps(0)).wait();
        await (await hub.setMinBurnAmount(0)).wait();
        await (await hub.setMintGriefingDeposit(ethers.utils.parseEther('0.001'))).wait();
        await (await hub.setVaultMarketMetrics(50, 30)).wait();
        console.log('Vault created');
    } else {
        console.log('Vault exists');
    }

    console.log('Step 1: Push fresh prices');
    await retryRedStone(() => wrappedHub.updateOraclePrices([], { gasLimit: 500000 })).then(tx => tx.wait());
    console.log('  Prices updated\n');

    const vault = await hub.getVault(wallet.address);
    const idle = vault.collateralShares.gt(vault.lockedCollateral)
        ? vault.collateralShares.sub(vault.lockedCollateral) : ethers.BigNumber.from(0);
    console.log('  Vault idle collateral shares:', ethers.utils.formatEther(idle));
    const wantShares = ethers.utils.parseEther('0.05');
    if (idle.lt(wantShares)) {
        const qqqbBalance = await qqqb.balanceOf(wallet.address);
        if (qqqbBalance.gte(wantShares)) {
            await (await qqqb.approve(HUB_ADDRESS, wantShares)).wait();
            await (await hub.depositCollateral(wantShares, { gasLimit: 500000 })).wait();
            console.log('  Deposited', ethers.utils.formatEther(wantShares), 'QQQB');
        } else {
            console.log('  QQQB balance', ethers.utils.formatEther(qqqbBalance), '— depositing what is available');
            if (qqqbBalance.gt(0)) {
                await (await qqqb.approve(HUB_ADDRESS, qqqbBalance)).wait();
                await (await hub.depositCollateral(qqqbBalance, { gasLimit: 500000 })).wait();
            }
        }
    }

    // --- Mint wsXMR if needed ---
    let wsxmrBalance = await wsxmr.balanceOf(wallet.address);
    console.log('  wsXMR balance:', ethers.utils.formatUnits(wsxmrBalance, 8));
    if (wsxmrBalance.lt(20000)) {
        console.log('Step 2: Mint wsXMR for co-LP');
        const secret = ethers.utils.randomBytes(32);
        const commitment = await ed25519Helper.computeCommitment(secret);
        const [userPubX, userPubY] = await ed25519Helper.scalarMultBase(ethers.BigNumber.from(secret));
        const compressed = await ed25519Helper.compressPublicKey(userPubX, userPubY);
        const userPublicKey = ethers.utils.hexZeroPad(compressed.toHexString(), 32);
        const xmrAmount = ethers.BigNumber.from('200000000');
        const griefingDeposit = ethers.utils.parseEther('0.001');

        await retryRedStone(() => wrappedHub.updateOraclePrices([], { gasLimit: 500000 })).then(tx => tx.wait());

        const mintTx = await hub.initiateMint(wallet.address, wallet.address, xmrAmount, commitment, userPublicKey, { value: griefingDeposit, gasLimit: 1500000 });
        const mintReceipt = await mintTx.wait();
        const requestId = mintReceipt.logs[0].topics[1];
        console.log('  Mint initiated:', mintTx.hash);

        await retryRedStone(() => wrappedHub.updateOraclePrices([], { gasLimit: 500000 })).then(tx => tx.wait());

        const lpSecret = ethers.utils.randomBytes(32);
        const [lpPubX, lpPubY] = await ed25519Helper.scalarMultBase(ethers.BigNumber.from(lpSecret));
        const lpPublicKey = ethers.utils.keccak256(ethers.utils.defaultAbiCoder.encode(['uint256', 'uint256'], [lpPubX, lpPubY]));
        await (await hub.provideLPKey(requestId, lpPublicKey, lpPublicKey, lpPublicKey, { gasLimit: 500000 })).wait();
        await (await hub.setMintReady(requestId, { gasLimit: 500000 })).wait();
        await (await hub.revealSecret(requestId, secret, { gasLimit: 1500000 })).wait();
        await (await hub.finalizeMint(requestId, { gasLimit: 1500000 })).wait();

        wsxmrBalance = await wsxmr.balanceOf(wallet.address);
        console.log('  Minted:', ethers.utils.formatUnits(wsxmrBalance, 8), 'wsXMR\n');
    } else {
        console.log('Step 2: already have wsXMR\n');
    }

    // --- Step 3: Open co-LP ---
    console.log('Step 3: Open co-LP position');
    const wsxmrToDeposit = wsxmrBalance.div(2);
    console.log('  Depositing', ethers.utils.formatUnits(wsxmrToDeposit, 8), 'wsXMR');
    if (wsxmrToDeposit.eq(0)) {
        console.error('  wsXMR deposit is 0 — aborting');
        process.exit(1);
    }

    await (await wsxmr.approve(HUB_ADDRESS, wsxmrToDeposit)).wait();
    await retryRedStone(() => wrappedHub.updateOraclePrices([], { gasLimit: 500000 })).then(tx => tx.wait());

    const deadline = Math.floor(Date.now() / 1000) + 3600;
    const coLPTx = await hub.userOpenCoLP(wallet.address, wsxmrToDeposit, deadline, { gasLimit: 2500000 });
    const coLPReceipt = await coLPTx.wait();
    console.log('  Co-LP TX:', coLPTx.hash);

    let tokenId = null;
    for (const log of coLPReceipt.logs) {
        try {
            const parsed = hub.interface.parseLog(log);
            if (parsed.name === 'CoLPDeployed') { tokenId = parsed.args.tokenId; break; }
        } catch (e) {}
    }
    console.log('  Position tokenId:', tokenId ? tokenId.toString() : 'unknown');
    console.log('  https://bscscan.com/tx/' + coLPTx.hash);

    const vaultAfter = await hub.getVault(wallet.address);
    console.log('  deployedSDAIShares:', ethers.utils.formatEther(vaultAfter.deployedSDAIShares));
    console.log('');

    if (process.env.KEEP_OPEN === '1') {
        console.log('Step 4: KEEP_OPEN=1 — leaving position live to seed pool liquidity');
        console.log('\nCo-LP test complete — https://bscscan.com/address/' + wallet.address);
        return;
    }

    // --- Step 4: Unwind ---
    console.log('Step 4: Unwind co-LP');
    const unwindTx = await hub.unwindCoLP(tokenId, deadline, { gasLimit: 2500000 });
    await unwindTx.wait();
    console.log('  Unwind TX:', unwindTx.hash);
    console.log('  https://bscscan.com/tx/' + unwindTx.hash);

    const pendingWsxmr = await hub.getPendingReturns(wallet.address, WSXMR_ADDRESS);
    console.log('  Pending wsXMR returns:', ethers.utils.formatUnits(pendingWsxmr, 8));
    if (pendingWsxmr.gt(0)) {
        await (await hub.withdrawReturns(WSXMR_ADDRESS, { gasLimit: 300000 })).wait();
        console.log('  Withdrawn');
    }

    console.log('  Final wsXMR balance:', ethers.utils.formatUnits(await wsxmr.balanceOf(wallet.address), 8));
    console.log('\nCo-LP test complete — https://bscscan.com/address/' + wallet.address);
}

main().catch(err => { console.error(err); process.exit(1); });
