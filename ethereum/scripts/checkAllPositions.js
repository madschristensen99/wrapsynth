#!/usr/bin/env node
require('dotenv').config();
const { ethers } = require('ethers');

const POSITION_MANAGER = '0xAE8fbE656a77519a7490054274910129c9244FA3';
const UNI_V3_FACTORY = '0xe32F7dD7e3f098D518ff19A22d5f028e076489B1';
const SDAI_ADDRESS = '0xaf204776c7245bF4147c2612BF6e5972Ee483701';
const WSXMR_ADDRESS = '0x8890f651190c838651623de077474a98e37803ab';
const POOL_FEE = 3000;

async function main() {
    const provider = new ethers.providers.JsonRpcProvider('https://rpc.gnosischain.com');

    const poolAbi = [
        'function slot0() external view returns (uint160 sqrtPriceX96,int24 tick,uint16 observationIndex,uint16 observationCardinality,uint16 observationCardinalityNext,uint8 feeProtocol,bool unlocked)',
        'function liquidity() external view returns (uint128)'
    ];
    const nftAbi = [
        'function positions(uint256 tokenId) external view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)'
    ];

    const factory = new ethers.Contract(UNI_V3_FACTORY, ['function getPool(address,address,uint24) external view returns (address)'], provider);
    const poolAddr = await factory.getPool(SDAI_ADDRESS, WSXMR_ADDRESS, POOL_FEE);
    const pool = new ethers.Contract(poolAddr, poolAbi, provider);
    const slot0 = await pool.slot0();
    const nft = new ethers.Contract(POSITION_MANAGER, nftAbi, provider);

    console.log('Current tick:', slot0.tick);
    console.log('');

    const tokenIds = [5475, 5476];
    for (const id of tokenIds) {
        try {
            const pos = await nft.positions(id);
            const inRange = slot0.tick >= pos.tickLower && slot0.tick <= pos.tickUpper;
            console.log(`Position ${id}:`);
            console.log('  tickLower:', pos.tickLower);
            console.log('  tickUpper:', pos.tickUpper);
            console.log('  liquidity:', pos.liquidity.toString());
            console.log('  status:', inRange ? 'IN RANGE ✓' : 'OUT OF RANGE ✗');
            console.log('');
        } catch (e) {
            console.log(`Position ${id}: does not exist or error`);
            console.log('');
        }
    }
}

main().catch(console.error);
