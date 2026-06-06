#!/usr/bin/env node
/**
 * Test both sides of the sDAI/wsXMR Uniswap V3 pool by doing small swaps
 */

require('dotenv').config();
const { ethers } = require('ethers');

const SDAI_ADDRESS = '0xaf204776c7245bF4147c2612BF6e5972Ee483701';
const WSXMR_ADDRESS = '0x8890f651190c838651623de077474a98e37803ab';
const POOL_ADDRESS = '0x3235ffe7B51b3726BC0F398da21eD0583103F106'; // from earlier: hub.liquidityRouter()
// Wait, that's the router. Need the actual pool.
const SWAP_ROUTER = '0xc6D25285D5C5b62b7ca26D6092751A145D50e9Be';
const UNI_V3_FACTORY = '0xe32F7dD7e3f098D518ff19A22d5f028e076489B1';

const POOL_FEE = 3000;

async function main() {
    if (!process.env.PRIVATE_KEY) {
        console.error('PRIVATE_KEY not set');
        process.exit(1);
    }

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
    const erc20Abi = [
        'function balanceOf(address) external view returns (uint256)',
        'function approve(address spender, uint256 amount) external returns (bool)',
        'function decimals() external view returns (uint8)',
        'function symbol() external view returns (string)'
    ];
    const routerAbi = [
        'function exactInputSingle(tuple(address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) external payable returns (uint256 amountOut)'
    ];

    const factory = new ethers.Contract(UNI_V3_FACTORY, factoryAbi, provider);
    const poolAddr = await factory.getPool(SDAI_ADDRESS, WSXMR_ADDRESS, POOL_FEE);
    console.log('Pool address:', poolAddr);

    if (poolAddr === ethers.constants.AddressZero) {
        console.error('Pool does not exist!');
        process.exit(1);
    }

    const pool = new ethers.Contract(poolAddr, poolAbi, provider);
    const slot0 = await pool.slot0();
    const liquidity = await pool.liquidity();
    const token0 = await pool.token0();
    const token1 = await pool.token1();

    console.log('Pool state:');
    console.log('  sqrtPriceX96:', slot0.sqrtPriceX96.toString());
    console.log('  tick:', slot0.tick);
    console.log('  liquidity:', liquidity.toString());
    console.log('  token0:', token0);
    console.log('  token1:', token1);
    console.log('');

    if (liquidity.eq(0)) {
        console.error('Pool has ZERO liquidity!');
        process.exit(1);
    }

    const sdai = new ethers.Contract(SDAI_ADDRESS, erc20Abi, wallet);
    const wsxmr = new ethers.Contract(WSXMR_ADDRESS, erc20Abi, wallet);
    const swapRouter = new ethers.Contract(SWAP_ROUTER, routerAbi, wallet);

    const sdaiBalance = await sdai.balanceOf(wallet.address);
    const wsxmrBalance = await wsxmr.balanceOf(wallet.address);
    const sdaiSymbol = await sdai.symbol();
    const wsxmrSymbol = await wsxmr.symbol();
    const sdaiDecimals = await sdai.decimals();
    const wsxmrDecimals = await wsxmr.decimals();

    console.log('Wallet balances:');
    console.log('  ', wsxmrSymbol + ':', ethers.utils.formatUnits(wsxmrBalance, wsxmrDecimals));
    console.log('  ', sdaiSymbol + ':', ethers.utils.formatUnits(sdaiBalance, sdaiDecimals));
    console.log('');

    if (wsxmrBalance.eq(0) && sdaiBalance.eq(0)) {
        console.error('No tokens to swap!');
        process.exit(1);
    }

    // --- Swap 1: wsXMR -> sDAI ---
    if (wsxmrBalance.gt(1000)) {
        const wsxmrSwapAmount = ethers.BigNumber.from('1000'); // 0.00001 wsXMR
        console.log('Swap 1: wsXMR -> sDAI');
        console.log('  Amount in:', ethers.utils.formatUnits(wsxmrSwapAmount, wsxmrDecimals), wsxmrSymbol);

        const approve1 = await wsxmr.approve(SWAP_ROUTER, wsxmrSwapAmount, {
            maxPriorityFeePerGas: ethers.utils.parseUnits('10', 'gwei'),
            maxFeePerGas: ethers.utils.parseUnits('20', 'gwei')
        });
        await approve1.wait();
        console.log('  Approved');

        const deadline = Math.floor(Date.now() / 1000) + 600;
        const params1 = {
            tokenIn: WSXMR_ADDRESS,
            tokenOut: SDAI_ADDRESS,
            fee: POOL_FEE,
            recipient: wallet.address,
            deadline: deadline,
            amountIn: wsxmrSwapAmount,
            amountOutMinimum: 0, // test script, accept any slippage
            sqrtPriceLimitX96: 0
        };

        const swap1 = await swapRouter.exactInputSingle(params1, {
            gasLimit: 300000,
            maxPriorityFeePerGas: ethers.utils.parseUnits('10', 'gwei'),
            maxFeePerGas: ethers.utils.parseUnits('20', 'gwei')
        });
        const receipt1 = await swap1.wait();
        console.log('  Swap TX:', swap1.hash);

        // Parse output from event
        const sdaiAfter1 = await sdai.balanceOf(wallet.address);
        const sdaiReceived = sdaiAfter1.sub(sdaiBalance);
        console.log('  sDAI received:', ethers.utils.formatUnits(sdaiReceived, sdaiDecimals));
        console.log('');
    } else {
        console.log('Skip swap 1: not enough wsXMR');
    }

    // --- Swap 2: sDAI -> wsXMR ---
    const sdaiBalanceAfter1 = await sdai.balanceOf(wallet.address);
    if (sdaiBalanceAfter1.gt(ethers.utils.parseUnits('0.0001', sdaiDecimals))) {
        const sdaiSwapAmount = sdaiBalanceAfter1.div(2); // swap half of sDAI
        console.log('Swap 2: sDAI -> wsXMR');
        console.log('  Amount in:', ethers.utils.formatUnits(sdaiSwapAmount, sdaiDecimals), sdaiSymbol);

        const approve2 = await sdai.approve(SWAP_ROUTER, sdaiSwapAmount, {
            maxPriorityFeePerGas: ethers.utils.parseUnits('10', 'gwei'),
            maxFeePerGas: ethers.utils.parseUnits('20', 'gwei')
        });
        await approve2.wait();
        console.log('  Approved');

        const deadline = Math.floor(Date.now() / 1000) + 600;
        const params2 = {
            tokenIn: SDAI_ADDRESS,
            tokenOut: WSXMR_ADDRESS,
            fee: POOL_FEE,
            recipient: wallet.address,
            deadline: deadline,
            amountIn: sdaiSwapAmount,
            amountOutMinimum: 0,
            sqrtPriceLimitX96: 0
        };

        const swap2 = await swapRouter.exactInputSingle(params2, {
            gasLimit: 300000,
            maxPriorityFeePerGas: ethers.utils.parseUnits('10', 'gwei'),
            maxFeePerGas: ethers.utils.parseUnits('20', 'gwei')
        });
        await swap2.wait();
        console.log('  Swap TX:', swap2.hash);

        const wsxmrAfter2 = await wsxmr.balanceOf(wallet.address);
        console.log('  Final wsXMR:', ethers.utils.formatUnits(wsxmrAfter2, wsxmrDecimals));
        console.log('');
    } else {
        console.log('Skip swap 2: not enough sDAI');
    }

    console.log('Pool swap test complete!');
}

main().catch(console.error);
