require('dotenv').config();
const { ethers } = require('ethers');

const HUB = '0xaF04319B462850Fa645EaDE5C816b4dC894d9575';

async function main() {
    const provider = new ethers.providers.JsonRpcProvider('https://rpc.gnosischain.com');
    const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
    
    const hub = new ethers.Contract(HUB, [
        'function withdrawCollateral(uint256 shares) external',
        'function getVault(address) view returns (tuple(address lpAddress, uint256 collateralShares, uint256 lockedCollateral, uint256 normalizedDebt, uint256 pendingDebt, uint16 maxMintBps, uint256 mintGriefingDeposit, uint256 mintReadyBond, uint16 mintFeeBps, uint16 burnRewardBps, uint256 liquidationNonce, uint256 mintNonce, uint256 minBurnAmount, bool active, uint256 deployedSDAIShares, uint16 maxCoLPRangeBps, uint256 mintTimeoutBlocks, uint256 burnTimeoutBlocks))'
    ], wallet);
    
    try {
        await hub.callStatic.withdrawCollateral(1);
        console.log('Call succeeded (unexpected)');
    } catch (err) {
        console.log('Error code:', err.code);
        console.log('Error message:', err.message);
        if (err.error && err.error.message) {
            console.log('RPC error:', err.error.message);
        }
        if (err.reason) {
            console.log('Revert reason:', err.reason);
        }
        if (err.data) {
            console.log('Error data:', err.data);
        }
    }
}
main().catch(console.error);
