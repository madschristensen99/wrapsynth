#!/usr/bin/env node
/**
 * Update oracle prices and withdraw LP collateral
 * Contract addresses are read from the canonical root deployment.json.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { ethers } = require('ethers');
const { WrapperBuilder } = require('@redstone-finance/evm-connector');
const { getSignersForDataServiceId } = require('@redstone-finance/oracles-smartweave-contracts');

const deployment = JSON.parse(fs.readFileSync(path.join(__dirname, '../../deployment.json'), 'utf8'));
const HUB_ADDRESS = deployment.contracts.wsXmrHub;
const SDAI_ADDRESS = deployment.externalContracts.sDAI;

async function main() {
    if (!process.env.PRIVATE_KEY) {
        throw new Error('PRIVATE_KEY not set in .env');
    }

    const provider = new ethers.providers.JsonRpcProvider(deployment.rpcUrl);
    const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
    
    console.log('LP address:', wallet.address);
    console.log('');

    const hubAbi = [
        'function getVault(address) view returns (tuple(address lpAddress, uint256 collateralShares, uint256 lockedCollateral, uint256 normalizedDebt, uint256 pendingDebt, uint16 maxMintBps, uint256 mintGriefingDeposit, uint256 mintReadyBond, uint16 mintFeeBps, uint16 burnRewardBps, uint256 liquidationNonce, uint256 mintNonce, uint256 minBurnAmount, bool active, uint256 deployedSDAIShares, uint16 maxCoLPRangeBps, uint256 mintTimeoutBlocks, uint256 burnTimeoutBlocks))',
        'function withdrawCollateral(uint256 shares) external',
        'function hasActiveVault(address) view returns (bool)',
        'function getXmrPrice() view returns (uint256)',
        'function getCollateralPrice() view returns (uint256)',
        'function updateOraclePrices(bytes[] calldata) external payable'
    ];
    
    const hub = new ethers.Contract(HUB_ADDRESS, hubAbi, wallet);
    
    // Step 1: Update oracle prices
    console.log('Step 1: Updating oracle prices...');
    const authorizedSigners = getSignersForDataServiceId("redstone-primary-prod");
    const wrappedHub = WrapperBuilder.wrap(hub).usingDataService({
        dataServiceId: "redstone-primary-prod",
        uniqueSignersCount: 3,
        dataPackagesIds: ["XMR", "DAI"],
        authorizedSigners
    });
    
    const updateTx = await wrappedHub.updateOraclePrices([]);
    console.log('Update TX:', updateTx.hash);
    await updateTx.wait();
    console.log('✅ Prices updated');
    console.log('');
    
    // Step 2: Check vault
    const hasVault = await hub.hasActiveVault(wallet.address);
    if (!hasVault) {
        console.log('❌ No active vault found');
        return;
    }
    
    const vault = await hub.getVault(wallet.address);
    console.log('Vault Details:');
    console.log('  Collateral Shares:', ethers.utils.formatEther(vault.collateralShares), 'sDAI');
    console.log('  Locked Collateral:', ethers.utils.formatEther(vault.lockedCollateral), 'sDAI');
    console.log('  Normalized Debt:', ethers.utils.formatUnits(vault.normalizedDebt, 8), 'wsXMR');
    console.log('  Pending Debt:', ethers.utils.formatUnits(vault.pendingDebt, 8), 'wsXMR');
    console.log('');
    
    // Step 3: Calculate safe withdraw amount (maintain 150% CR)
    const sdaiAbi = ['function convertToAssets(uint256 shares) view returns (uint256)', 'function balanceOf(address) view returns (uint256)'];
    const sdai = new ethers.Contract(SDAI_ADDRESS, sdaiAbi, provider);
    
    const xmrPrice = await hub.getXmrPrice();
    const collateralPrice = await hub.getCollateralPrice();
    console.log('Live Prices:');
    console.log('  XMR:', ethers.utils.formatUnits(xmrPrice, 18), 'USD');
    console.log('  Collateral:', ethers.utils.formatUnits(collateralPrice, 18), 'USD');
    console.log('');
    
    const collateralAssets = await sdai.convertToAssets(vault.collateralShares);
    const collateralValueUsd = collateralAssets.mul(collateralPrice).div(ethers.utils.parseEther('1'));
    const debtValueUsd = vault.normalizedDebt.mul(xmrPrice).div(1e8);
    const requiredCollateralUsd = debtValueUsd.mul(150).div(100);
    const withdrawableUsd = collateralValueUsd.gt(requiredCollateralUsd)
        ? collateralValueUsd.sub(requiredCollateralUsd)
        : ethers.BigNumber.from(0);
    
    console.log('Financial Summary:');
    console.log('  Collateral Value:', ethers.utils.formatEther(collateralValueUsd), 'USD');
    console.log('  Debt Value:', ethers.utils.formatEther(debtValueUsd), 'USD');
    console.log('  Required (150%):', ethers.utils.formatEther(requiredCollateralUsd), 'USD');
    console.log('  Withdrawable:', ethers.utils.formatEther(withdrawableUsd), 'USD');
    console.log('');
    
    if (withdrawableUsd.lte(0)) {
        console.log('❌ No collateral to withdraw (would drop below 150% CR)');
        return;
    }
    
    const withdrawableAssets = withdrawableUsd.mul(ethers.utils.parseEther('1')).div(collateralPrice);
    const withdrawableShares = collateralAssets.gt(0)
        ? withdrawableAssets.mul(vault.collateralShares).div(collateralAssets)
        : ethers.BigNumber.from(0);
    const safeWithdrawShares = withdrawableShares.mul(95).div(100);
    
    console.log('Step 2: Withdrawing', ethers.utils.formatEther(safeWithdrawShares), 'sDAI shares...');
    const withdrawTx = await hub.withdrawCollateral(safeWithdrawShares, { gasLimit: 500000 });
    console.log('Withdraw TX:', withdrawTx.hash);
    await withdrawTx.wait();
    console.log('✅ Withdrawn!');
    console.log('');
    
    // Check balance
    const balance = await sdai.balanceOf(wallet.address);
    console.log('Your sDAI balance:', ethers.utils.formatEther(balance), 'sDAI');
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
