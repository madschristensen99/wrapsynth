#!/usr/bin/env node
require('dotenv').config();
const { ethers } = require('ethers');
const { HUB_ADDRESS, SDAI_ADDRESS } = require('./deploymentConfig');

async function main() {
    const provider = new ethers.providers.JsonRpcProvider('https://rpc.gnosischain.com');
    const hub = new ethers.Contract(HUB_ADDRESS, [
        'function getVault(address) view returns (tuple(address lpAddress, uint256 collateralShares, uint256 lockedCollateral, uint256 normalizedDebt, uint256 pendingDebt, uint256 maxMintBps, uint256 minBurnAmount, bool active))',
        'function globalDebtIndex() view returns (uint256)',
        'function getXmrPrice() view returns (uint256)',
        'function getCollateralPrice() view returns (uint256)'
    ], provider);
    
    const sDAI = new ethers.Contract(SDAI_ADDRESS, [
        'function convertToAssets(uint256 shares) view returns (uint256)'
    ], provider);
    
    const vaultAddr = '0x492c0b9F298cC49FE2644a2EBc6eA8dF848c72FB';
    const vault = await hub.getVault(vaultAddr);
    const globalDebtIndex = await hub.globalDebtIndex();
    const xmrPrice = await hub.getXmrPrice();
    const collPrice = await hub.getCollateralPrice();
    
    // Convert shares to assets
    const collAssets = await sDAI.convertToAssets(vault.collateralShares);
    const collAmountDAI = Number(collAssets) / 1e18;
    
    // Denormalize debt
    const actualDebt = vault.normalizedDebt.mul(globalDebtIndex).div(ethers.constants.WeiPerEther);
    const debtAmount = Number(actualDebt) / 1e8;
    const pendingDebtAmount = Number(vault.pendingDebt) / 1e8;
    
    const xmrPriceUsd = Number(xmrPrice) / 1e18;
    const collPriceUsd = Number(collPrice) / 1e18;
    
    const debtValueUsd = debtAmount * xmrPriceUsd;
    const pendingDebtValueUsd = pendingDebtAmount * xmrPriceUsd;
    
    const usedCollateral = debtValueUsd / collPriceUsd;
    const pendingCollateral = pendingDebtValueUsd / collPriceUsd;
    const bufferCollateral = (usedCollateral + pendingCollateral) * 0.5;
    const freeCollateral = Math.max(0, collAmountDAI - usedCollateral - pendingCollateral - bufferCollateral);
    
    console.log('Vault Capacity Analysis:');
    console.log('========================');
    console.log('Collateral (DAI):', collAmountDAI.toFixed(4));
    console.log('Used (backing debt):', usedCollateral.toFixed(4));
    console.log('Pending:', pendingCollateral.toFixed(4));
    console.log('Buffer (50%):', bufferCollateral.toFixed(4));
    console.log('FREE CAPACITY:', freeCollateral.toFixed(4), 'DAI');
    console.log('');
    console.log('Max mint capacity:', (freeCollateral * collPriceUsd / (1.5 * xmrPriceUsd)).toFixed(6), 'XMR');
}

main().catch(console.error);
