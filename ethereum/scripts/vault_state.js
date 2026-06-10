const { ethers } = require('ethers');
const HUB = '0xaF04319B462850Fa645EaDE5C816b4dC894d9575';
const SDAI = '0xaf204776c7245bF4147c2612BF6e5972Ee483701';

async function main() {
    const provider = new ethers.providers.JsonRpcProvider('https://rpc.gnosischain.com');
    const hub = new ethers.Contract(HUB, [
        'function getVault(address) view returns (tuple(address lpAddress, uint256 collateralShares, uint256 lockedCollateral, uint256 normalizedDebt, uint256 pendingDebt, uint16 maxMintBps, uint256 mintGriefingDeposit, uint256 mintReadyBond, uint16 mintFeeBps, uint16 burnRewardBps, uint256 liquidationNonce, uint256 mintNonce, uint256 minBurnAmount, bool active, uint256 deployedSDAIShares, uint16 maxCoLPRangeBps, uint256 mintTimeoutBlocks, uint256 burnTimeoutBlocks))',
        'function getXmrPrice() view returns (uint256)',
        'function getCollateralPrice() view returns (uint256)'
    ], provider);
    
    const sdai = new ethers.Contract(SDAI, [
        'function convertToAssets(uint256) view returns (uint256)'
    ], provider);
    
    const vault = await hub.getVault('0x492c0b9F298cC49FE2644a2EBc6eA8dF848c72FB');
    console.log('collateralShares:', vault.collateralShares.toString());
    console.log('lockedCollateral:', vault.lockedCollateral.toString());
    console.log('normalizedDebt:', vault.normalizedDebt.toString());
    console.log('pendingDebt:', vault.pendingDebt.toString());
    console.log('deployedSDAIShares:', vault.deployedSDAIShares.toString());
    
    try {
        const xmr = await hub.getXmrPrice();
        const dai = await hub.getCollateralPrice();
        console.log('xmrPrice:', xmr.toString());
        console.log('daiPrice:', dai.toString());
        
        const assets = await sdai.convertToAssets(vault.collateralShares);
        console.log('collateralAssets:', assets.toString());
        
        // Compute what the contract would compute
        const debtValueUsd = vault.normalizedDebt.mul(xmr).div(1e8);
        console.log('debtValueUsd:', ethers.utils.formatEther(debtValueUsd));
        
        const collateralValueUsd = assets.mul(dai).div(ethers.utils.parseEther('1'));
        console.log('collateralValueUsd:', ethers.utils.formatEther(collateralValueUsd));
        
        const required = debtValueUsd.mul(150).div(100);
        console.log('requiredCollateralUsd:', ethers.utils.formatEther(required));
    } catch (e) {
        console.log('Price error:', e.reason || e.message);
    }
}
main().catch(console.error);
