const { ethers } = require('ethers');

const HUB = '0xaF04319B462850Fa645EaDE5C816b4dC894d9575';
const POS_MANAGER = '0xAE8fbE656a77519a7490054274910129c9244FA3';
const WALLET = '0x492c0b9F298cC49FE2644a2EBc6eA8dF848c72FB';

async function main() {
    const provider = new ethers.providers.JsonRpcProvider('https://rpc.gnosischain.com');
    const nft = new ethers.Contract(POS_MANAGER, [
        'function ownerOf(uint256) view returns (address)',
        'function positions(uint256) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)'
    ], provider);
    
    for (const id of [5475, 5476, 5477, 5478, 5479, 5480]) {
        try {
            const owner = await nft.ownerOf(id);
            const pos = await nft.positions(id);
            console.log('Token', id, 'owner:', owner, 'liquidity:', pos.liquidity.toString());
        } catch (e) {
            console.log('Token', id, ':', e.reason || 'not found');
        }
    }
}
main().catch(console.error);
