const { ethers } = require('ethers');
const HUB = '0xaF04319B462850Fa645EaDE5C816b4dC894d9575';
async function main() {
    const provider = new ethers.providers.JsonRpcProvider('https://rpc.gnosischain.com');
    const hub = new ethers.Contract(HUB, [
        'function globalDebtIndex() view returns (uint256)',
        'function getVault(address) view returns (tuple(address lpAddress, uint256 collateralShares, uint256 lockedCollateral, uint256 normalizedDebt, uint256 pendingDebt, uint16 maxMintBps, uint256 mintGriefingDeposit, uint256 mintReadyBond, uint16 mintFeeBps, uint16 burnRewardBps, uint256 liquidationNonce, uint256 mintNonce, uint256 minBurnAmount, bool active, uint256 deployedSDAIShares, uint16 maxCoLPRangeBps, uint256 mintTimeoutBlocks, uint256 burnTimeoutBlocks))',
        'function getXmrPrice() view returns (uint256)',
        'function getCollateralPrice() view returns (uint256)'
    ], provider);
    
    try {
        const idx = await hub.globalDebtIndex();
        console.log('globalDebtIndex:', idx.toString());
    } catch (e) {
        console.log('globalDebtIndex not accessible:', e.reason || e.message);
    }
    
    const vault = await hub.getVault('0x492c0b9F298cC49FE2644a2EBc6eA8dF848c72FB');
    const xmr = await hub.getXmrPrice();
    const dai = await hub.getCollateralPrice();
    
    console.log('normalizedDebt:', vault.normalizedDebt.toString());
    console.log('pendingDebt:', vault.pendingDebt.toString());
    console.log('XMR price:', ethers.utils.formatUnits(xmr, 18));
    console.log('DAI price:', ethers.utils.formatUnits(dai, 18));
    
    // Try to compute debt value using different globalDebtIndex guesses
    for (const idx of [1e18, 2e18, 5e18, 1e19, 1e20]) {
        const denorm = vault.normalizedDebt.mul(Math.floor(idx)).div(ethers.utils.parseEther('1'));
        const total = denorm.add(vault.pendingDebt);
        const debtUsd = total.mul(xmr).div(1e8);
        console.log('If globalDebtIndex=' + idx + ': denorm=' + denorm.toString() + ', total=' + total.toString() + ', debtUSD=' + ethers.utils.formatEther(debtUsd));
    }
}
main().catch(console.error);
