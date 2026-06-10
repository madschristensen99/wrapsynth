require('dotenv').config();
const { ethers } = require('ethers');
const deployment = require('./deploymentConfig');

const HUB_ABI = [
    'function getVault(address) view returns (tuple(address lpAddress, uint256 collateralShares, uint256 lockedCollateral, uint256 normalizedDebt, uint256 pendingDebt, uint16 maxMintBps, uint256 mintGriefingDeposit, uint256 mintReadyBond, uint16 mintFeeBps, uint16 burnRewardBps, uint256 liquidationNonce, uint256 mintNonce, uint256 minBurnAmount, bool active, uint256 deployedSDAIShares, uint16 maxCoLPRangeBps, uint256 mintTimeoutBlocks, uint256 burnTimeoutBlocks))',
    'function withdrawCollateral(uint256 amount) external',
    'function getXmrPrice() view returns (uint256)',
    'function getCollateralPrice() view returns (uint256)'
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
    
    const vault = await hub.getVault(wallet.address);
    const xmrPrice = await hub.getXmrPrice();
    const collateralPrice = await hub.getCollateralPrice();
    
    const collateralAssets = await sdai.convertToAssets(vault.collateralShares);
    const collateralValueUsd = collateralAssets.mul(collateralPrice).div(ethers.utils.parseEther('1'));
    const debtValueUsd = vault.normalizedDebt.mul(xmrPrice).div(1e8);
    const requiredCollateralUsd = debtValueUsd.mul(150).div(100);
    const withdrawableUsd = collateralValueUsd.gt(requiredCollateralUsd)
        ? collateralValueUsd.sub(requiredCollateralUsd)
        : ethers.BigNumber.from(0);
    
    if (withdrawableUsd.lte(0)) {
        console.log('Nothing to withdraw');
        return;
    }
    
    const withdrawableAssets = withdrawableUsd.mul(ethers.utils.parseEther('1')).div(collateralPrice);
    const withdrawableShares = collateralAssets.gt(0)
        ? withdrawableAssets.mul(vault.collateralShares).div(collateralAssets)
        : ethers.BigNumber.from(0);
    const safeWithdrawShares = withdrawableShares.mul(95).div(100);
    
    console.log('Withdrawing shares:', safeWithdrawShares.toString());
    console.log('Assets:', ethers.utils.formatEther(await sdai.convertToAssets(safeWithdrawShares)), 'sDAI');
    
    const tx = await hub.withdrawCollateral(safeWithdrawShares, { gasLimit: 500000 });
    console.log('TX:', tx.hash);
    const receipt = await tx.wait();
    console.log('✅ Confirmed in block', receipt.blockNumber);
    
    const vaultAfter = await hub.getVault(wallet.address);
    console.log('Remaining collateral shares:', vaultAfter.collateralShares.toString());
    console.log('sDAI balance:', ethers.utils.formatEther(await sdai.balanceOf(wallet.address)), 'sDAI');
}

main().catch(console.error);
