#!/usr/bin/env node
require('dotenv').config();
const { ethers } = require('ethers');
const { WrapperBuilder } = require('@redstone-finance/evm-connector');
const { getSignersForDataServiceId } = require('@redstone-finance/oracles-smartweave-contracts');

const HUB_ADDRESS = '0xd32e2ece901094550b81ab5051a72256761514d6'; // Gnosis Mainnet - June 4, 2026
const SDAI_ADDRESS = '0xaf204776c7245bF4147c2612BF6e5972Ee483701';

async function main() {
    const provider = new ethers.providers.JsonRpcProvider('https://rpc.gnosischain.com');
    const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
    
    console.log('💰 Withdrawing Safe Amount from wsXmrHub');
    console.log('========================================');
    console.log('Wallet:', wallet.address);
    console.log('');
    
    const hubAbi = [
        'function getVault(address lpAddress) external view returns (tuple(address lpAddress, uint256 collateralShares, uint256 lockedCollateral, uint256 normalizedDebt, uint256 pendingDebt, uint16 maxMintBps, uint256 mintGriefingDeposit, uint256 mintReadyBond, uint16 mintFeeBps, uint16 burnRewardBps, uint256 liquidationNonce, uint256 mintNonce, uint256 minBurnAmount, bool active))',
        'function withdrawCollateral(uint256 amount) external',
        'function getXmrPrice() external view returns (uint256)',
        'function getCollateralPrice() external view returns (uint256)',
        'function updateOraclePrices(bytes[] calldata) external payable'
    ];
    
    const sdaiAbi = [
        'function convertToAssets(uint256 shares) external view returns (uint256)'
    ];
    
    const hub = new ethers.Contract(HUB_ADDRESS, hubAbi, wallet);
    const sdai = new ethers.Contract(SDAI_ADDRESS, sdaiAbi, provider);
    
    // Wrap with RedStone for price updates
    const authorizedSigners = getSignersForDataServiceId("redstone-primary-prod");
    const wrappedHub = WrapperBuilder.wrap(hub).usingDataService({
        dataServiceId: "redstone-primary-prod",
        uniqueSignersCount: 3,
        dataPackagesIds: ["XMR", "DAI"],
        authorizedSigners
    });
    
    // Update prices first
    console.log('📊 Updating prices...');
    const updateTx = await wrappedHub.updateOraclePrices([]);
    await updateTx.wait();
    console.log('✅ Prices updated\n');
    
    // Get vault state
    const vault = await hub.getVault(wallet.address);
    const xmrPrice = await hub.getXmrPrice();
    const collateralPrice = await hub.getCollateralPrice();
    
    console.log('Vault State:');
    console.log('  Collateral Shares:', vault.collateralShares.toString());
    console.log('  Normalized Debt:', vault.normalizedDebt.toString());
    console.log('');
    
    console.log('Prices:');
    console.log('  XMR Price:', ethers.utils.formatUnits(xmrPrice, 18), 'USD');
    console.log('  Collateral Price:', ethers.utils.formatUnits(collateralPrice, 18), 'USD');
    console.log('');
    
    // Calculate collateral value
    const collateralAssets = await sdai.convertToAssets(vault.collateralShares);
    const collateralValueUsd = collateralAssets.mul(collateralPrice).div(ethers.utils.parseEther('1'));
    console.log('Collateral Value:', ethers.utils.formatEther(collateralValueUsd), 'USD');
    
    // Calculate debt value (wsXMR has 8 decimals)
    const debtValueUsd = vault.normalizedDebt.mul(xmrPrice).div(1e8);
    console.log('Debt Value:', ethers.utils.formatEther(debtValueUsd), 'USD');
    console.log('');
    
    // Calculate required collateral for 150% ratio
    const requiredCollateralUsd = debtValueUsd.mul(150).div(100);
    console.log('Required Collateral (150%):', ethers.utils.formatEther(requiredCollateralUsd), 'USD');
    
    // Calculate withdrawable amount
    const withdrawableUsd = collateralValueUsd.sub(requiredCollateralUsd);
    console.log('Withdrawable Value:', ethers.utils.formatEther(withdrawableUsd), 'USD');
    
    if (withdrawableUsd.lte(0)) {
        console.log('⚠️  No collateral available to withdraw');
        return;
    }
    
    // Convert to shares (leave a small buffer)
    const withdrawableAssets = withdrawableUsd.mul(ethers.utils.parseEther('1')).div(collateralPrice);
    const withdrawableShares = withdrawableAssets.mul(vault.collateralShares).div(collateralAssets);
    
    // Withdraw 95% of withdrawable to leave buffer
    const safeWithdrawShares = withdrawableShares.mul(95).div(100);
    
    console.log('Safe Withdraw Amount:', ethers.utils.formatEther(await sdai.convertToAssets(safeWithdrawShares)), 'DAI');
    console.log('');
    
    console.log('📤 Withdrawing...');
    const withdrawTx = await hub.withdrawCollateral(safeWithdrawShares, { gasLimit: 500000 });
    console.log('TX:', withdrawTx.hash);
    await withdrawTx.wait();
    console.log('✅ Withdrawal complete!');
}

main().catch(console.error);
