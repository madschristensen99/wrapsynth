#!/usr/bin/env node
/**
 * Withdraw all available LP collateral
 */

require('dotenv').config();
const { ethers } = require('ethers');

// NEW CONTRACT - June 4, 2026 deployment
const HUB_ADDRESS = '0xd32e2ece901094550b81ab5051a72256761514d6';
const SDAI_ADDRESS = '0xaf204776c7245bF4147c2612BF6e5972Ee483701';

async function main() {
    if (!process.env.PRIVATE_KEY) {
        throw new Error('PRIVATE_KEY not set in .env');
    }

    const provider = new ethers.providers.JsonRpcProvider('https://rpc.gnosischain.com');
    const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

    console.log('LP address:', wallet.address);
    console.log('Hub address:', HUB_ADDRESS);
    console.log('');

    const hubAbi = [
        'function getVault(address) view returns (tuple(address lpAddress, uint256 collateralShares, uint256 lockedCollateral, uint256 normalizedDebt, uint256 pendingDebt, uint16 maxMintBps, uint256 mintGriefingDeposit, uint256 mintReadyBond, uint16 mintFeeBps, uint16 burnRewardBps, uint256 liquidationNonce, uint256 mintNonce, uint256 minBurnAmount, bool active, uint256 deployedSDAIShares, uint16 maxCoLPRangeBps, uint256 mintTimeoutBlocks, uint256 burnTimeoutBlocks))',
        'function withdrawCollateral(uint256 shares) external',
        'function hasActiveVault(address) view returns (bool)',
        'function getPendingReturns(address user, address token) view returns (uint256)'
    ];

    const hub = new ethers.Contract(HUB_ADDRESS, hubAbi, wallet);

    // Check vault
    const hasVault = await hub.hasActiveVault(wallet.address);
    console.log('Has active vault:', hasVault);

    if (!hasVault) {
        console.log('❌ No active vault found');
        return;
    }

    const vault = await hub.getVault(wallet.address);
    console.log('');
    console.log('Vault Details:');
    console.log('  Collateral Shares:', vault.collateralShares.toString());
    console.log('  Locked Collateral:', vault.lockedCollateral.toString());
    console.log('  Normalized Debt:  ', vault.normalizedDebt.toString());
    console.log('  Active:           ', vault.active);
    console.log('');

    const withdrawable = vault.collateralShares.sub(vault.lockedCollateral);
    console.log('Withdrawable (shares - locked):', withdrawable.toString());

    if (withdrawable.lte(0)) {
        console.log('❌ No collateral to withdraw');
        return;
    }

    console.log('');
    console.log('Step: Withdrawing', ethers.utils.formatEther(withdrawable), 'sDAI shares...');
    const withdrawTx = await hub.withdrawCollateral(withdrawable);
    console.log('Withdraw TX:', withdrawTx.hash);
    await withdrawTx.wait();
    console.log('✅ Withdrawn!');
    console.log('');

    // Check sDAI balance
    const sdaiAbi = ['function balanceOf(address) view returns (uint256)'];
    const sdai = new ethers.Contract(SDAI_ADDRESS, sdaiAbi, provider);
    const balance = await sdai.balanceOf(wallet.address);
    console.log('Your sDAI balance:', ethers.utils.formatEther(balance), 'sDAI');
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error('Error:', error.message || error);
        if (error.error && error.error.message) {
            console.error('RPC Error:', error.error.message);
        }
        if (error.reason) {
            console.error('Revert reason:', error.reason);
        }
        process.exit(1);
    });
