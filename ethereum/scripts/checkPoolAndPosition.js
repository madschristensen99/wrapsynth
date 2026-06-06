#!/usr/bin/env node
/**
 * Check pool state and Co-LP position status
 */

require('dotenv').config();
const { ethers } = require('ethers');

const SDAI_ADDRESS = '0xaf204776c7245bF4147c2612BF6e5972Ee483701';
const WSXMR_ADDRESS = '0x8890f651190c838651623de077474a98e37803ab';
const POSITION_MANAGER = '0xAE8fbE656a77519a7490054274910129c9244FA3';
const UNI_V3_FACTORY = '0xe32F7dD7e3f098D518ff19A22d5f028e076489B1';
const HUB_ADDRESS = '0xd32e2ece901094550b81ab5051a72256761514d6';
const TOKEN_ID = 5477; // from latest Co-LP

const POOL_FEE = 3000;

async function main() {
    const provider = new ethers.providers.JsonRpcProvider('https://rpc.gnosischain.com');
    const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
    console.log('Wallet:', wallet.address);
    console.log('');

    const factoryAbi = ['function getPool(address,address,uint24) external view returns (address)'];
    const poolAbi = [
        'function slot0() external view returns (uint160 sqrtPriceX96,int24 tick,uint16 observationIndex,uint16 observationCardinality,uint16 observationCardinalityNext,uint8 feeProtocol,bool unlocked)',
        'function liquidity() external view returns (uint128)',
        'function token0() external view returns (address)',
        'function token1() external view returns (address)'
    ];
    const nftAbi = [
        'function positions(uint256 tokenId) external view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)',
        'function ownerOf(uint256 tokenId) external view returns (address)'
    ];
    const erc20Abi = [
        'function balanceOf(address) external view returns (uint256)',
        'function decimals() external view returns (uint8)',
        'function symbol() external view returns (string)'
    ];

    const factory = new ethers.Contract(UNI_V3_FACTORY, factoryAbi, provider);
    const poolAddr = await factory.getPool(SDAI_ADDRESS, WSXMR_ADDRESS, POOL_FEE);
    console.log('Pool address:', poolAddr);

    const pool = new ethers.Contract(poolAddr, poolAbi, provider);
    const slot0 = await pool.slot0();
    const liquidity = await pool.liquidity();
    const token0 = await pool.token0();
    const token1 = await pool.token1();

    console.log('Pool state:');
    console.log('  sqrtPriceX96:', slot0.sqrtPriceX96.toString());
    console.log('  tick:', slot0.tick);
    console.log('  liquidity:', liquidity.toString());
    console.log('  token0:', token0, '(wsXMR)');
    console.log('  token1:', token1, '(sDAI)');
    console.log('');

    // Check position
    const nft = new ethers.Contract(POSITION_MANAGER, nftAbi, provider);
    const owner = await nft.ownerOf(TOKEN_ID);
    console.log('Position', TOKEN_ID, 'owner:', owner);
    console.log('Hub address:', HUB_ADDRESS);
    console.log('');

    const pos = await nft.positions(TOKEN_ID);
    console.log('Position details:');
    console.log('  token0:', pos.token0);
    console.log('  token1:', pos.token1);
    console.log('  fee:', pos.fee);
    console.log('  tickLower:', pos.tickLower);
    console.log('  tickUpper:', pos.tickUpper);
    console.log('  liquidity:', pos.liquidity.toString());
    console.log('  tokensOwed0:', pos.tokensOwed0.toString());
    console.log('  tokensOwed1:', pos.tokensOwed1.toString());
    console.log('');

    const inRange = slot0.tick >= pos.tickLower && slot0.tick <= pos.tickUpper;
    console.log('Current tick:', slot0.tick);
    console.log('Position range:', pos.tickLower, 'to', pos.tickUpper);
    console.log('Position is', inRange ? 'IN RANGE ✓' : 'OUT OF RANGE ✗');
    console.log('');

    const sdai = new ethers.Contract(SDAI_ADDRESS, erc20Abi, provider);
    const wsxmr = new ethers.Contract(WSXMR_ADDRESS, erc20Abi, provider);
    const sdaiBal = await sdai.balanceOf(wallet.address);
    const wsxmrBal = await wsxmr.balanceOf(wallet.address);
    console.log('Wallet balances:');
    console.log('  wsXMR:', ethers.utils.formatUnits(wsxmrBal, 8));
    console.log('  sDAI:', ethers.utils.formatUnits(sdaiBal, 18));

    if (!inRange) {
        console.log('');
        console.log('WARNING: Position is out of range. No active liquidity for swaps.');
        console.log('The Co-LP position needs to be unwound and re-opened at the current price.');
    } else if (pos.liquidity.eq(0)) {
        console.log('');
        console.log('WARNING: Position has zero liquidity.');
    }
}

main().catch(console.error);
