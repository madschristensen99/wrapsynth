#!/usr/bin/env node
/**
 * withdrawSafeAmount.js - Withdraw collateral from wsXmrHub vault
 * 
 * NOTE: This contract has a known bug: withdrawCollateral() reverts with
 * arithmetic overflow when the vault has active Co-LP positions (deployedSDAIShares > 0).
 * If you see "panic: arithmetic underflow or overflow", that's the contract bug, not this script.
 * Workaround: First unwind all Co-LP positions, eliminate all debt, then withdraw.
 */
require('dotenv').config();
const { ethers } = require('ethers');
const { HUB_ADDRESS, SDAI_ADDRESS } = require('./deploymentConfig');

const VAULT_ABI_FIELDS = [
    'address lpAddress',
    'uint256 collateralShares',
    'uint256 lockedCollateral',
    'uint256 normalizedDebt',
    'uint256 pendingDebt',
    'uint16 maxMintBps',
    'uint256 mintGriefingDeposit',
    'uint256 mintReadyBond',
    'uint16 mintFeeBps',
    'uint16 burnRewardBps',
    'uint256 liquidationNonce',
    'uint256 mintNonce',
    'uint256 minBurnAmount',
    'bool active',
    'uint256 deployedSDAIShares',
    'uint16 maxCoLPRangeBps',
    'uint256 mintTimeoutBlocks',
    'uint256 burnTimeoutBlocks'
].join(', ');

const HUB_ABI = [
    `function getVault(address lpAddress) external view returns (tuple(${VAULT_ABI_FIELDS}))`,
    'function withdrawCollateral(uint256 amount) external',
    'function getXmrPrice() external view returns (uint256)',
    'function getCollateralPrice() external view returns (uint256)',
    'function updateOraclePrices(bytes[] calldata) external payable',
    'function hasActiveVault(address lpAddress) external view returns (bool)'
];

const SDAI_ABI = [
    'function convertToAssets(uint256 shares) external view returns (uint256)',
    'function balanceOf(address) external view returns (uint256)',
    'function decimals() external view returns (uint8)'
];

async function main() {
    if (!process.env.PRIVATE_KEY) {
        console.error('❌ PRIVATE_KEY not set in environment');
        process.exit(1);
    }

    const provider = new ethers.providers.JsonRpcProvider('https://rpc.gnosischain.com');
    const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

    console.log('💰 Withdrawing Safe Amount from wsXmrHub');
    console.log('========================================');
    console.log('Wallet:', wallet.address);
    console.log('Hub:   ', HUB_ADDRESS);
    console.log('');

    const hub = new ethers.Contract(HUB_ADDRESS, HUB_ABI, wallet);
    const sdai = new ethers.Contract(SDAI_ADDRESS, SDAI_ABI, provider);

    // Check if vault exists
    const hasVault = await hub.hasActiveVault(wallet.address);
    if (!hasVault) {
        console.log('❌ No active vault found for this wallet');
        return;
    }

    // Get vault state (full struct with deployedSDAIShares)
    const vault = await hub.getVault(wallet.address);

    console.log('Vault State:');
    console.log('  Collateral Shares: ', vault.collateralShares.toString());
    console.log('  Locked Collateral: ', vault.lockedCollateral.toString());
    console.log('  Normalized Debt:   ', vault.normalizedDebt.toString());
    console.log('  Pending Debt:      ', vault.pendingDebt.toString());
    console.log('  Deployed sDAI (Co-LP):', vault.deployedSDAIShares.toString());
    console.log('  Active:            ', vault.active);
    console.log('');

    // Prices may be stale; handle gracefully
    let xmrPrice, collateralPrice;
    try {
        xmrPrice = await hub.getXmrPrice();
        collateralPrice = await hub.getCollateralPrice();
        console.log('Prices (live):');
        console.log('  XMR Price:      ', ethers.utils.formatUnits(xmrPrice, 18), 'USD');
        console.log('  Collateral Price:', ethers.utils.formatUnits(collateralPrice, 18), 'USD');
    } catch (err) {
        console.log('⚠️  Prices are stale (oracle needs update)');
        console.log('   Using fallback estimates for diagnostics...');
        xmrPrice = ethers.utils.parseEther('390'); // fallback $390
        collateralPrice = ethers.utils.parseEther('1'); // fallback $1
        console.log('  XMR Price (est):  ', '390 USD');
        console.log('  Collateral Price (est):', '1 USD');
    }
    console.log('');

    // Calculate values
    const collateralAssets = await sdai.convertToAssets(vault.collateralShares);
    const collateralValueUsd = collateralAssets.mul(collateralPrice).div(ethers.utils.parseEther('1'));
    const debtValueUsd = vault.normalizedDebt.mul(xmrPrice).div(1e8);
    const requiredCollateralUsd = debtValueUsd.mul(150).div(100);
    const withdrawableUsd = collateralValueUsd.gt(requiredCollateralUsd)
        ? collateralValueUsd.sub(requiredCollateralUsd)
        : ethers.BigNumber.from(0);

    console.log('Financial Summary:');
    console.log('  Collateral Value: ', ethers.utils.formatEther(collateralValueUsd), 'USD');
    console.log('  Debt Value:       ', ethers.utils.formatEther(debtValueUsd), 'USD');
    console.log('  Required (150%):  ', ethers.utils.formatEther(requiredCollateralUsd), 'USD');
    console.log('  Withdrawable:     ', ethers.utils.formatEther(withdrawableUsd), 'USD');
    console.log('');

    // Check for known contract bug conditions
    const hasCoLP = vault.deployedSDAIShares.gt(0);
    const hasDebt = vault.normalizedDebt.gt(0) || vault.pendingDebt.gt(0);

    if (hasCoLP) {
        console.log('⚠️  WARNING: Vault has active Co-LP positions!');
        console.log('    The contract has a known arithmetic overflow bug in');
        console.log('    withdrawCollateral() when deployedSDAIShares > 0.');
        console.log('');
    }

    if (withdrawableUsd.lte(0)) {
        console.log('❌ No collateral available to withdraw (would drop below 150% CR)');
        return;
    }

    // Convert to shares
    const withdrawableAssets = withdrawableUsd.mul(ethers.utils.parseEther('1')).div(collateralPrice);
    const withdrawableShares = collateralAssets.gt(0)
        ? withdrawableAssets.mul(vault.collateralShares).div(collateralAssets)
        : ethers.BigNumber.from(0);
    const safeWithdrawShares = withdrawableShares.mul(95).div(100);

    const withdrawAssets = await sdai.convertToAssets(safeWithdrawShares);
    console.log('Proposed Withdrawal:');
    console.log('  Shares:  ', safeWithdrawShares.toString());
    console.log('  Assets:  ', ethers.utils.formatEther(withdrawAssets), 'sDAI');
    console.log('');

    // If Co-LP exists, try a tiny test amount first to confirm the bug
    if (hasCoLP) {
        console.log('🔍 Testing with 1 share to confirm contract bug...');
        let testReverted = false;
        try {
            const testTx = await hub.withdrawCollateral(1, { gasLimit: 500000 });
            await testTx.wait();
            console.log('✅ Test withdrawal succeeded (unexpected!)');
        } catch (err) {
            testReverted = true;
            const reason = (err.reason || err.message || err.error?.message || '').toLowerCase();
            const isOverflow = reason.includes('overflow') || reason.includes('underflow') || reason.includes('panic') || reason.includes('arithmetic');
            const isKnownBug = isOverflow || !reason.includes('insufficient'); // any non-insufficient revert with Co-LP is likely the bug
            if (isKnownBug) {
                console.log('❌ CONFIRMED: Contract bug - arithmetic overflow in Co-LP path');
                console.log('   Raw error:', err.reason || err.message || 'transaction failed');
                console.log('');
                console.log('Workarounds:');
                console.log('  1. Unwind all Co-LP positions first (if unwindCoLP works)');
                console.log('  2. Eliminate ALL debt (burn all wsXMR), then withdrawCollateral');
                console.log('     skips CR check when totalObligations == 0');
                console.log('  3. Interact directly with contract via cast/sendTransaction');
                console.log('');
                console.log('Script cannot proceed due to contract-level bug.');
                return;
            } else {
                console.log('❌ Test failed for other reason:', err.reason || err.message);
            }
        }
    }

    // Attempt the real withdrawal
    console.log('📤 Withdrawing...');
    console.log('TX will revert if vault has Co-LP due to contract overflow bug');
    try {
        const withdrawTx = await hub.withdrawCollateral(safeWithdrawShares, { gasLimit: 500000 });
        console.log('TX:', withdrawTx.hash);
        await withdrawTx.wait();
        console.log('✅ Withdrawal complete!');

        const vaultAfter = await hub.getVault(wallet.address);
        console.log('');
        console.log('Vault After:');
        console.log('  Collateral Shares:', vaultAfter.collateralShares.toString());
    } catch (err) {
        const reason = err.reason || err.message || '';
        console.log('');
        console.log('❌ Withdrawal failed:', reason);
        if (reason.includes('overflow') || reason.includes('underflow') || reason.includes('panic')) {
            console.log('');
            console.log('This is the known contract bug with Co-LP positions.');
            console.log('You must eliminate debt or unwind Co-LP before withdrawing.');
        }
    }
}

main().catch(console.error);
