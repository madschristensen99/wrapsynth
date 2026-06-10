const { ethers } = require('ethers');
const HUB = '0xaF04319B462850Fa645EaDE5C816b4dC894d9575';
async function main() {
    const provider = new ethers.providers.JsonRpcProvider('https://rpc.gnosischain.com');
    const hub = new ethers.Contract(HUB, [
        'function getXmrPrice() view returns (uint256)',
        'function getCollateralPrice() view returns (uint256)',
        'function lastXmrPriceTimestamp() view returns (uint256)',
        'function lastCollateralPriceTimestamp() view returns (uint256)'
    ], provider);
    try {
        const xmr = await hub.getXmrPrice();
        const dai = await hub.getCollateralPrice();
        const xmrTs = await hub.lastXmrPriceTimestamp();
        const daiTs = await hub.lastCollateralPriceTimestamp();
        const now = Math.floor(Date.now() / 1000);
        console.log('XMR price:', ethers.utils.formatUnits(xmr, 18), 'USD (updated', now - xmrTs.toNumber(), 'seconds ago)');
        console.log('DAI price:', ethers.utils.formatUnits(dai, 18), 'USD (updated', now - daiTs.toNumber(), 'seconds ago)');
    } catch (err) {
        console.log('Prices stale or error:', err.reason || err.message);
    }
}
main().catch(console.error);
