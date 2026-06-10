require('dotenv').config();
const { ethers } = require('ethers');
const { WrapperBuilder } = require('@redstone-finance/evm-connector');
const { getSignersForDataServiceId } = require('@redstone-finance/oracles-smartweave-contracts');

const deployment = require('./deploymentConfig');

const HUB_ABI = [
    'function getVault(address) view returns (tuple(address lpAddress, uint256 collateralShares, uint256 lockedCollateral, uint256 normalizedDebt, uint256 pendingDebt, uint16 maxMintBps, uint256 mintGriefingDeposit, uint256 mintReadyBond, uint16 mintFeeBps, uint16 burnRewardBps, uint256 liquidationNonce, uint256 mintNonce, uint256 minBurnAmount, bool active, uint256 deployedSDAIShares, uint16 maxCoLPRangeBps, uint256 mintTimeoutBlocks, uint256 burnTimeoutBlocks))',
    'function withdrawCollateral(uint256 amount) external',
    'function getXmrPrice() view returns (uint256)',
    'function getCollateralPrice() view returns (uint256)',
    'function updateOraclePrices(bytes[] calldata) external payable',
    'function hasActiveVault(address) view returns (bool)'
];

const SDAI_ABI = [
    'function convertToAssets(uint256 shares) view returns (uint256)',
    'function balanceOf(address) view returns (uint256)'
];

async function main() {
    const provider = new ethers.providers.JsonRpcProvider('https://rpc.gnosischain.com');
    const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
    
    const hub = new ethers.Contract(deployment.HUB_ADDRESS, HUB_ABI, wallet);
    const sdai = new ethers.Contract(deployment.SDAI_ADDRESS, SDAI_ABI, provider);
    
    // Pre-calculate safe amount BEFORE updating prices
    const vault = await hub.getVault(wallet.address);
    
    // Step 1: Update prices rapidly
    console.log('Updating prices...');
    const authorizedSigners = getSignersForDataServiceId("redstone-primary-prod");
    const wrappedHub = WrapperBuilder.wrap(hub).usingDataService({
        dataServiceId: "redstone-primary-prod",
        uniqueSignersCount: 3,
        dataPackagesIds: ["XMR", "DAI"],
        authorizedSigners
    });
    
    const updateTx = await wrappedHub.updateOraclePrices([]);
    console.log('Price TX:', updateTx.hash);
    
    // Step 2: IMMEDIATELY send withdrawal without waiting for price tx confirmation
    // We need fresh prices for the calculation
    const xmrPrice = await hub.getXmrPrice();
    const collateralPrice = await hub.getCollateralPrice();
    console.log('Prices - XMR:', ethers.utils.formatUnits(xmrPrice, 18), 'DAI:', ethers.utils.formatUnits(collateralPrice, 18));
    
    const collateralAssets = await sdai.convertToAssets(vault.collateralShares);
    const collateralValueUsd = collateralAssets.mul(collateralPrice).div(ethers.utils.parseEther('1'));
    const debtValueUsd = vault.normalizedDebt.mul(xmrPrice).div(1e8);
    const requiredCollateralUsd = debtValueUsd.mul(150).div(100);
    const withdrawableUsd = collateralValueUsd.gt(requiredCollateralUsd)
        ? collateralValueUsd.sub(requiredCollateralUsd)
        : ethers.BigNumber.from(0);
    
    if (withdrawableUsd.lte(0)) {
        console.log('Nothing to withdraw');
        await updateTx.wait();
        return;
    }
    
    const withdrawableAssets = withdrawableUsd.mul(ethers.utils.parseEther('1')).div(collateralPrice);
    const withdrawableShares = collateralAssets.gt(0)
        ? withdrawableAssets.mul(vault.collateralShares).div(collateralAssets)
        : ethers.BigNumber.from(0);
    const safeWithdrawShares = withdrawableShares.mul(95).div(100);
    
    console.log('Safe withdraw shares:', safeWithdrawShares.toString());
    console.log('Sending withdrawal immediately...');
    
    const withdrawTx = await hub.withdrawCollateral(safeWithdrawShares, { gasLimit: 500000 });
    console.log('Withdraw TX:', withdrawTx.hash);
    
    // Now wait for both
    console.log('Waiting for price update...');
    await updateTx.wait();
    console.log('Price update confirmed');
    
    console.log('Waiting for withdrawal...');
    const receipt = await withdrawTx.wait();
    if (receipt.status === 1) {
        console.log('✅ Withdrawal confirmed in block', receipt.blockNumber);
    } else {
        console.log('❌ Withdrawal reverted');
    }
    
    const vaultAfter = await hub.getVault(wallet.address);
    console.log('Remaining collateral:', vaultAfter.collateralShares.toString());
}

main().catch(err => {
    console.error('Error:', err.message || err);
    process.exit(1);
});
