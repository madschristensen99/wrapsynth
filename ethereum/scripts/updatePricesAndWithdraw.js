#!/usr/bin/env node
/**
 * Update oracle prices and withdraw LP collateral
 */

require('dotenv').config();
const { ethers } = require('ethers');
const { WrapperBuilder } = require('@redstone-finance/evm-connector');
const { getSignersForDataServiceId } = require('@redstone-finance/oracles-smartweave-contracts');

const HUB_ADDRESS = '0x025B1499B5f4E51a0053aB1742B2Ecd545615e5a'; // June 8, 2026
const SDAI_ADDRESS = '0xaf204776c7245bF4147c2612BF6e5972Ee483701';

async function main() {
    if (!process.env.PRIVATE_KEY) {
        throw new Error('PRIVATE_KEY not set in .env');
    }

    const provider = new ethers.providers.JsonRpcProvider('https://rpc.gnosischain.com');
    const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
    
    console.log('LP address:', wallet.address);
    console.log('');

    const hubAbi = [
        'function getVault(address) view returns (tuple(address lpAddress, uint256 collateralShares, uint256 lockedCollateral, uint256 normalizedDebt, uint256 pendingDebt, uint16 maxMintBps, uint256 mintGriefingDeposit, uint256 mintReadyBond, uint16 mintFeeBps, uint16 burnRewardBps, uint256 liquidationNonce, uint256 mintNonce, uint256 minBurnAmount, bool active, uint256 deployedSDAIShares, uint16 maxCoLPRangeBps, uint256 mintTimeoutBlocks, uint256 burnTimeoutBlocks))',
        'function withdrawCollateral(uint256 shares) external',
        'function hasActiveVault(address) view returns (bool)',
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
    console.log('');
    
    const withdrawable = vault.collateralShares.sub(vault.lockedCollateral);
    
    if (withdrawable.lte(0)) {
        console.log('❌ No collateral to withdraw');
        return;
    }
    
    // Step 3: Withdraw
    console.log('Step 2: Withdrawing', ethers.utils.formatEther(withdrawable), 'sDAI shares...');
    const withdrawTx = await hub.withdrawCollateral(withdrawable);
    console.log('Withdraw TX:', withdrawTx.hash);
    await withdrawTx.wait();
    console.log('✅ Withdrawn!');
    console.log('');
    
    // Check balance
    const sdaiAbi = ['function balanceOf(address) view returns (uint256)'];
    const sdai = new ethers.Contract(SDAI_ADDRESS, sdaiAbi, provider);
    const balance = await sdai.balanceOf(wallet.address);
    console.log('Your sDAI balance:', ethers.utils.formatEther(balance), 'sDAI');
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
