require('dotenv').config();
const { ethers } = require('ethers');
const deployment = require('./deploymentConfig');

async function main() {
    const provider = new ethers.providers.JsonRpcProvider('https://rpc.gnosischain.com');
    const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
    
    const hub = new ethers.Contract(deployment.HUB_ADDRESS, [
        'function withdrawCollateral(uint256 shares) external',
        'function getVault(address) view returns (tuple(address lpAddress, uint256 collateralShares, uint256 lockedCollateral, uint256 normalizedDebt, uint256 pendingDebt, uint16 maxMintBps, uint256 mintGriefingDeposit, uint256 mintReadyBond, uint16 mintFeeBps, uint16 burnRewardBps, uint256 liquidationNonce, uint256 mintNonce, uint256 minBurnAmount, bool active, uint256 deployedSDAIShares, uint16 maxCoLPRangeBps, uint256 mintTimeoutBlocks, uint256 burnTimeoutBlocks))',
        'function getXmrPrice() view returns (uint256)',
        'function getCollateralPrice() view returns (uint256)'
    ], wallet);
    
    const vault = await hub.getVault(wallet.address);
    console.log('Collateral:', vault.collateralShares.toString());
    console.log('Locked:', vault.lockedCollateral.toString());
    console.log('NormalizedDebt:', vault.normalizedDebt.toString());
    console.log('PendingDebt:', vault.pendingDebt.toString());
    console.log('Deployed:', vault.deployedSDAIShares.toString());
    
    const xmr = await hub.getXmrPrice();
    const dai = await hub.getCollateralPrice();
    console.log('XMR price:', ethers.utils.formatUnits(xmr, 18));
    console.log('DAI price:', ethers.utils.formatUnits(dai, 18));
    
    const shares = ethers.BigNumber.from('276541699276612163');
    console.log('Testing withdraw of', shares.toString(), 'shares...');
    
    try {
        await hub.callStatic.withdrawCollateral(shares);
        console.log('SUCCESS');
    } catch (err) {
        console.log('REVERT:', err.reason || err.message);
        if (err.data) console.log('Data:', err.data);
    }
}
main().catch(console.error);
