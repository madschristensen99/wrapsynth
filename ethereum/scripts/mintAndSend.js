#!/usr/bin/env node
require('dotenv').config();
const { ethers } = require('ethers');
const { WrapperBuilder } = require('@redstone-finance/evm-connector');
const { getSignersForDataServiceId } = require('@redstone-finance/oracles-smartweave-contracts');
const { HUB_ADDRESS, WSXMR_ADDRESS, ED25519_HELPER } = require('./deploymentConfig');

const RECIPIENT_ADDRESS = '0xDFdC570ec0586D5c00735a2277c21Dcc254B3917';

async function main() {
    if (!process.env.PRIVATE_KEY) {
        console.error('PRIVATE_KEY not set');
        process.exit(1);
    }

    const provider = new ethers.providers.JsonRpcProvider('https://rpc.gnosischain.com');
    const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
    console.log('Wallet:', wallet.address);
    console.log('Recipient:', RECIPIENT_ADDRESS);

    const hubAbi = [
        'function initiateMint(address lpVault, address initiator, uint256 wsxmrAmount, bytes32 claimCommitment, bytes32 userPublicKey) external payable returns (bytes32)',
        'function provideLPKey(bytes32 requestId, bytes32 lpPublicSpendKey, bytes32 lpPublicViewKey) external',
        'function setMintReady(bytes32 requestId) external payable',
        'function finalizeMint(bytes32 requestId, bytes32 secret) external',
        'function updateOraclePrices(bytes[] calldata updateData) external payable',
        'function hasActiveVault(address lpAddress) external view returns (bool)',
        'function getVault(address lpAddress) external view returns (tuple(address lpAddress, uint256 collateralShares, uint256 lockedCollateral, uint256 normalizedDebt, uint256 pendingDebt, uint16 maxMintBps, uint256 mintGriefingDeposit, uint256 mintReadyBond, uint16 mintFeeBps, uint16 burnRewardBps, uint256 liquidationNonce, uint256 mintNonce, uint256 minBurnAmount, bool active, uint256 deployedSDAIShares, uint16 maxCoLPRangeBps, uint256 mintTimeoutBlocks, uint256 burnTimeoutBlocks))',
        'function globalDebtIndex() external view returns (uint256)',
        'function globalTotalDebt() external view returns (uint256)',
        'function getActualDebt(uint256 normalizedDebt) external view returns (uint256)',
        'function lastXmrPrice() external view returns (int192)',
        'function lastCollateralPrice() external view returns (int192)'
    ];

    const wsxmrAbi = [
        'function balanceOf(address) external view returns (uint256)',
        'function approve(address spender, uint256 amount) external returns (bool)',
        'function transfer(address recipient, uint256 amount) external returns (bool)',
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

    // Check vault state first
    const hasVault = await hub.hasActiveVault(wallet.address);
    console.log('  Has active vault:', hasVault);
    const globalDebtIndex = await hub.globalDebtIndex();
    const globalTotalDebt = await hub.globalTotalDebt();
    const xmrPriceRaw = await hub.lastXmrPrice();
    const collateralPriceRaw = await hub.lastCollateralPrice();
    const xmrPrice = ethers.BigNumber.from(xmrPriceRaw);
    const collateralPrice = ethers.BigNumber.from(collateralPriceRaw);
    console.log('  Global debt index:', globalDebtIndex.toString());
    console.log('  Global total debt:', globalTotalDebt.toString());
    console.log('  XMR price (raw):', xmrPrice.toString());
    console.log('  Collateral price (raw):', collateralPrice.toString());

    if (hasVault) {
        const vault = await hub.getVault(wallet.address);
        const actualDebt = await hub.getActualDebt(vault.normalizedDebt);
        const totalProjectedDebt = actualDebt.add(vault.pendingDebt).add(ethers.BigNumber.from('50000')); // 0.0005 wsXMR
        const availableCollateral = vault.collateralShares.gt(vault.lockedCollateral)
            ? vault.collateralShares.sub(vault.lockedCollateral)
            : ethers.BigNumber.from(0);

        // Manual CR calc: collateralValueUsd * 100 / debtValueUsd
        // collateralValueUsd = (collateralShares * convertToAssets) * collateralPrice / 1e18
        // But we need convertToAssets... approximate: sDAI shares ~= assets at ~1.045
        // Let's use raw shares for approximation
        const collateralValueUsd = availableCollateral.mul(collateralPrice).div(ethers.BigNumber.from('1000000000000000000'));
        const debtValueUsd = totalProjectedDebt.mul(xmrPrice).div(ethers.BigNumber.from('100000000'));
        const ratio = debtValueUsd.gt(0) ? collateralValueUsd.mul(100).div(debtValueUsd) : ethers.BigNumber.from('999999');

        console.log('  Vault collateralShares:', vault.collateralShares.toString());
        console.log('  Vault lockedCollateral:', vault.lockedCollateral.toString());
        console.log('  Vault normalizedDebt: ', vault.normalizedDebt.toString());
        console.log('  Vault actualDebt (denorm):', actualDebt.toString());
        console.log('  Vault pendingDebt:    ', vault.pendingDebt.toString());
        console.log('  Vault maxMintBps:', vault.maxMintBps.toString());
        console.log('  Vault minBurnAmount:', vault.minBurnAmount.toString());
        console.log('  Vault active:', vault.active);
        console.log('');
        console.log('  Available collateral (shares):', availableCollateral.toString());
        console.log('  Total projected debt (+0.0005 wsXMR):', totalProjectedDebt.toString());
        console.log('  Collateral value USD (approx):', ethers.utils.formatUnits(collateralValueUsd, 18));
        console.log('  Debt value USD (approx):', ethers.utils.formatUnits(debtValueUsd, 18));
        console.log('  Computed CR (need >=150):', ratio.toString());
    }

    const secret = ethers.utils.randomBytes(32);
    const secretHex = ethers.utils.hexlify(secret);
    console.log('  Secret (save this!):', secretHex);
    const commitment = await ed25519Helper.computeCommitment(secret);
    const xmrAmount = ethers.BigNumber.from('500000000'); // produces 50000 wsXMR (0.0005)
    const griefingDeposit = ethers.utils.parseEther('0.001');

    const [userPubX, userPubY] = await ed25519Helper.scalarMultBase(ethers.BigNumber.from(secret));
    const compressed = await ed25519Helper.compressPublicKey(userPubX, userPubY);
    const userPublicKey = ethers.utils.hexZeroPad(compressed.toHexString(), 32);

    // Simulate first to catch revert reason
    try {
        await hub.callStatic.initiateMint(
            wallet.address,
            wallet.address,
            xmrAmount,
            commitment,
            userPublicKey,
            { value: griefingDeposit }
        );
        console.log('  Simulation passed');
    } catch (simErr) {
        console.error('  Simulation FAILED:', simErr.reason || simErr.message);
        process.exit(1);
    }

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

    if (wsxmrBalance.eq(0)) {
        console.error('ERROR: No wsXMR to send');
        process.exit(1);
    }

    // Step 3: Transfer wsXMR to recipient
    console.log('Transferring wsXMR to recipient...');
    const transferTx = await wsxmr.transfer(RECIPIENT_ADDRESS, wsxmrBalance, {
        gasLimit: 100000,
        maxPriorityFeePerGas: ethers.utils.parseUnits('10', 'gwei'),
        maxFeePerGas: ethers.utils.parseUnits('20', 'gwei')
    });
    await transferTx.wait();
    console.log('  Transfer TX:', transferTx.hash);
    console.log('  Amount:', ethers.utils.formatUnits(wsxmrBalance, 8), 'wsXMR');

    const recipientBalance = await wsxmr.balanceOf(RECIPIENT_ADDRESS);
    const senderBalance = await wsxmr.balanceOf(wallet.address);
    console.log('  Recipient balance:', ethers.utils.formatUnits(recipientBalance, 8), 'wsXMR');
    console.log('  Sender balance:', ethers.utils.formatUnits(senderBalance, 8), 'wsXMR');
    console.log('Done!');
}

main().catch(console.error);
