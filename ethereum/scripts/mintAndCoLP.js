#!/usr/bin/env node
require('dotenv').config();
const { ethers } = require('ethers');
const { WrapperBuilder } = require('@redstone-finance/evm-connector');
const { getSignersForDataServiceId } = require('@redstone-finance/oracles-smartweave-contracts');
const { HUB_ADDRESS, WSXMR_ADDRESS, ED25519_HELPER } = require('./deploymentConfig');

async function main() {
    if (!process.env.PRIVATE_KEY) {
        console.error('PRIVATE_KEY not set');
        process.exit(1);
    }

    const provider = new ethers.providers.JsonRpcProvider('https://rpc.gnosischain.com');
    const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
    console.log('Wallet:', wallet.address);

    const hubAbi = [
        'function initiateMint(address lpVault, address initiator, uint256 wsxmrAmount, bytes32 claimCommitment, bytes32 userPublicKey) external payable returns (bytes32)',
        'function provideLPKey(bytes32 requestId, bytes32 lpPublicSpendKey, bytes32 lpPublicViewKey) external',
        'function setMintReady(bytes32 requestId) external payable',
        'function finalizeMint(bytes32 requestId, bytes32 secret) external',
        'function updateOraclePrices(bytes[] calldata updateData) external payable',
        'function userOpenCoLP(address lpVault, uint256 wsxmrAmount, uint256 deadline) external returns (uint256 tokenId)',
        'function hasActiveVault(address lpAddress) external view returns (bool)',
        'function getVault(address lpAddress) external view returns (tuple(address lpAddress, uint256 collateralShares, uint256 lockedCollateral, uint256 normalizedDebt, uint256 pendingDebt, uint16 maxMintBps, uint256 mintGriefingDeposit, uint256 mintReadyBond, uint16 mintFeeBps, uint16 burnRewardBps, uint256 liquidationNonce, uint256 mintNonce, uint256 minBurnAmount, bool active, uint256 deployedSDAIShares, uint16 maxCoLPRangeBps, uint256 mintTimeoutBlocks, uint256 burnTimeoutBlocks))',
        'function withdrawCollateral(uint256 amount) external',
        'function getPendingReturns(address user, address token) external view returns (uint256)',
        'function withdrawReturns(address token) external',
        'event CoLPDeployed(address indexed lpVault, address indexed user, uint256 indexed tokenId, uint256 sDAIShares, uint256 wsxmrAmount, uint16 rangeBps)'
    ];

    const wsxmrAbi = [
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
    const wsxmr = new ethers.Contract(WSXMR_ADDRESS, wsxmrAbi, wallet);
    const ed25519Helper = new ethers.Contract(ED25519_HELPER, ed25519HelperAbi, provider);

    const authorizedSigners = getSignersForDataServiceId('redstone-primary-prod');
    const wrappedHub = WrapperBuilder.wrap(hub).usingDataService({
        dataServiceId: 'redstone-primary-prod',
        uniqueSignersCount: 3,
        dataPackagesIds: ['XMR', 'DAI'],
        authorizedSigners
    });

    // Step 1: Push fresh prices
    console.log('Pushing fresh oracle prices...');
    const priceTx = await wrappedHub.updateOraclePrices([], { gasLimit: 500000 });
    await priceTx.wait();
    console.log('  Prices updated:', priceTx.hash);

    // Step 2: Mint wsXMR
    console.log('Minting wsXMR...');
    const secret = ethers.utils.randomBytes(32);
    const secretHex = ethers.utils.hexlify(secret);
    console.log('  Secret (save this!):', secretHex);
    const commitment = await ed25519Helper.computeCommitment(secret);
    const xmrAmount = ethers.BigNumber.from('100000000'); // produces 10000 wsXMR (0.0001) - smaller amount
    const griefingDeposit = ethers.utils.parseEther('0.001');

    const [userPubX, userPubY] = await ed25519Helper.scalarMultBase(ethers.BigNumber.from(secret));
    const compressed = await ed25519Helper.compressPublicKey(userPubX, userPubY);
    const userPublicKey = ethers.utils.hexZeroPad(compressed.toHexString(), 32);

    const mintTx = await hub.initiateMint(
        wallet.address,
        wallet.address,
        xmrAmount,
        commitment,
        userPublicKey,
        { value: griefingDeposit, gasLimit: 500000, maxPriorityFeePerGas: ethers.utils.parseUnits('10', 'gwei'), maxFeePerGas: ethers.utils.parseUnits('20', 'gwei') }
    );
    const mintReceipt = await mintTx.wait();
    const requestId = mintReceipt.logs[0].topics[1];
    console.log('  Mint initiated:', mintTx.hash);
    console.log('  Request ID:', requestId);

    // Refresh prices
    const refreshTx = await wrappedHub.updateOraclePrices([], { gasLimit: 500000 });
    await refreshTx.wait();
    console.log('  Prices refreshed');

    // LP key
    const lpSecret = ethers.utils.randomBytes(32);
    const [lpPubX, lpPubY] = await ed25519Helper.scalarMultBase(ethers.BigNumber.from(lpSecret));
    const lpPublicKey = ethers.utils.keccak256(ethers.utils.defaultAbiCoder.encode(['uint256', 'uint256'], [lpPubX, lpPubY]));
    
    try {
        const provideTx = await hub.provideLPKey(requestId, lpPublicKey, lpPublicKey, { gasLimit: 200000, maxPriorityFeePerGas: ethers.utils.parseUnits('10', 'gwei'), maxFeePerGas: ethers.utils.parseUnits('20', 'gwei') });
        await provideTx.wait();
        console.log('  LP key provided');
    } catch (err) {
        if (err.code === 'TRANSACTION_REPLACED' && err.replacement && err.receipt.status === 1) {
            console.log('  LP key provided (tx replaced but succeeded)');
        } else {
            throw err;
        }
    }

    try {
        const readyTx = await hub.setMintReady(requestId, { value: griefingDeposit, gasLimit: 200000, maxPriorityFeePerGas: ethers.utils.parseUnits('10', 'gwei'), maxFeePerGas: ethers.utils.parseUnits('20', 'gwei') });
        await readyTx.wait();
        console.log('  Mint ready');
    } catch (err) {
        if (err.code === 'TRANSACTION_REPLACED' && err.replacement && err.receipt.status === 1) {
            console.log('  Mint ready (tx replaced but succeeded)');
        } else {
            throw err;
        }
    }

    try {
        const finalizeTx = await hub.finalizeMint(requestId, secret, { gasLimit: 1000000, maxPriorityFeePerGas: ethers.utils.parseUnits('10', 'gwei'), maxFeePerGas: ethers.utils.parseUnits('20', 'gwei') });
        await finalizeTx.wait();
        console.log('  Mint finalized:', finalizeTx.hash);
    } catch (err) {
        if (err.code === 'TRANSACTION_REPLACED' && err.replacement && err.receipt.status === 1) {
            console.log('  Mint finalized (tx replaced but succeeded)');
        } else {
            throw err;
        }
    }

    const wsxmrBalance = await wsxmr.balanceOf(wallet.address);
    console.log('  wsXMR balance after mint:', ethers.utils.formatUnits(wsxmrBalance, 8));

    // Step 3: Co-LP half
    const wsxmrToDeposit = wsxmrBalance.div(2);
    console.log('Co-LPing', ethers.utils.formatUnits(wsxmrToDeposit, 8), 'wsXMR...');

    if (wsxmrToDeposit.eq(0)) {
        console.error('ERROR: wsxmrToDeposit is 0');
        process.exit(1);
    }

    const approveTx = await wsxmr.approve(HUB_ADDRESS, wsxmrToDeposit, { maxPriorityFeePerGas: ethers.utils.parseUnits('10', 'gwei'), maxFeePerGas: ethers.utils.parseUnits('20', 'gwei') });
    await approveTx.wait();

    const preCoLPTx = await wrappedHub.updateOraclePrices([], { gasLimit: 500000 });
    await preCoLPTx.wait();
    console.log('  Prices pushed');

    const deadline = Math.floor(Date.now() / 1000) + 3600;
    const coLPTx = await hub.userOpenCoLP(wallet.address, wsxmrToDeposit, deadline, { gasLimit: 2000000, maxPriorityFeePerGas: ethers.utils.parseUnits('10', 'gwei'), maxFeePerGas: ethers.utils.parseUnits('20', 'gwei') });
    const coLPReceipt = await coLPTx.wait();
    console.log('  Co-LP TX:', coLPTx.hash);

    let tokenId = null;
    if (coLPReceipt.events) {
        const evt = coLPReceipt.events.find(e => e.event === 'CoLPDeployed');
        if (evt) tokenId = evt.args.tokenId;
    }
    if (!tokenId) {
        for (const log of coLPReceipt.logs) {
            try {
                const parsed = hub.interface.parseLog(log);
                if (parsed.name === 'CoLPDeployed') {
                    tokenId = parsed.args.tokenId;
                    break;
                }
            } catch (e) {}
        }
    }

    console.log('  Token ID:', tokenId ? ethers.BigNumber.from(tokenId).toString() : 'unknown');
    console.log('  View on Gnosisscan: https://gnosisscan.io/tx/' + coLPTx.hash);

    const finalBalance = await wsxmr.balanceOf(wallet.address);
    console.log('  Final wsXMR balance:', ethers.utils.formatUnits(finalBalance, 8));

    // Step 4: Small vault withdrawal test after Co-LP
    console.log('');
    console.log('=== Vault Withdrawal Test (after Co-LP) ===');

    const hasVault = await hub.hasActiveVault(wallet.address);
    if (!hasVault) {
        console.log('  No vault found, skipping withdrawal test');
    } else {
        const vaultBefore = await hub.getVault(wallet.address);
        console.log('Vault before withdrawal:');
        console.log('  Collateral shares: ', vaultBefore.collateralShares.toString());
        console.log('  Locked collateral: ', vaultBefore.lockedCollateral.toString());
        console.log('  Normalized debt:   ', vaultBefore.normalizedDebt.toString());
        console.log('  Deployed sDAI:     ', vaultBefore.deployedSDAIShares.toString());
        console.log('');

        // Update prices before withdrawal
        const preWithdrawPriceTx = await wrappedHub.updateOraclePrices([], { gasLimit: 500000 });
        await preWithdrawPriceTx.wait();
        console.log('  Prices updated for withdrawal');

        // Try a very small withdrawal (1 share) to test the path
        const testWithdrawAmount = ethers.BigNumber.from('1');
        console.log('  Attempting small withdrawal of', testWithdrawAmount.toString(), 'share(s)...');

        try {
            const withdrawTx = await hub.withdrawCollateral(testWithdrawAmount, {
                gasLimit: 500000,
                maxPriorityFeePerGas: ethers.utils.parseUnits('10', 'gwei'),
                maxFeePerGas: ethers.utils.parseUnits('20', 'gwei')
            });
            await withdrawTx.wait();
            console.log('  ✅ Withdrawal succeeded! TX:', withdrawTx.hash);
        } catch (err) {
            const reason = (err.reason || err.message || '').toLowerCase();
            if (reason.includes('overflow') || reason.includes('underflow') || reason.includes('panic')) {
                console.log('  ❌ Withdrawal reverted with arithmetic error (known Co-LP overflow bug)');
            } else if (reason.includes('insufficient') || reason.includes('below')) {
                console.log('  ❌ Withdrawal reverted: collateral ratio too low');
            } else {
                console.log('  ❌ Withdrawal reverted:', err.reason || err.message.split('\n')[0]);
            }
        }

        const vaultAfter = await hub.getVault(wallet.address);
        console.log('');
        console.log('Vault after withdrawal:');
        console.log('  Collateral shares: ', vaultAfter.collateralShares.toString());
        console.log('  Locked collateral: ', vaultAfter.lockedCollateral.toString());
        console.log('  Normalized debt:   ', vaultAfter.normalizedDebt.toString());
        console.log('  Deployed sDAI:     ', vaultAfter.deployedSDAIShares.toString());
    }

    console.log('');
    console.log('Done!');
}

main().catch(console.error);
