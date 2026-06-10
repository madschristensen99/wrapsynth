const { ethers } = require('ethers');

const HUB = '0xaF04319B462850Fa645EaDE5C816b4dC894d9575';
const POS_MANAGER = '0xAE8fbE656a77519a7490054274910129c9244FA3';

async function main() {
    const provider = new ethers.providers.JsonRpcProvider('https://rpc.gnosischain.com');
    const nft = new ethers.Contract(POS_MANAGER, [
        'function balanceOf(address) view returns (uint256)',
        'function tokenOfOwnerByIndex(address, uint256) view returns (uint256)',
        'function positions(uint256) view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)'
    ], provider);
    
    const balance = await nft.balanceOf(HUB);
    console.log('NFTs owned by hub:', balance.toString());
    
    for (let i = 0; i < balance; i++) {
        const tokenId = await nft.tokenOfOwnerByIndex(HUB, i);
        const pos = await nft.positions(tokenId);
        console.log('Token', tokenId.toString(), ': liquidity=', pos.liquidity.toString(), ', tick=[', pos.tickLower, ',', pos.tickUpper, ']');
    }
}
main().catch(console.error);
