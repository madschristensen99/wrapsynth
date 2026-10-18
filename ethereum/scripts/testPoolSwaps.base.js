#!/usr/bin/env node
/**
 * Test swaps on the live wsXMR/cbBTC Uniswap V3 pool (Base).
 * Routes through Uniswap SwapRouter02 — the same path real users take.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { ethers } = require('ethers');
const { WSXMR_ADDRESS, QQQB_ADDRESS, POOL_ADDRESS, UNI_SWAP_ROUTER, RPC_URL, EXPLORER } = require('./deploymentConfig.base');

const POOL_FEE = 500;

async function main() {
    if (!process.env.PRIVATE_KEY) {
        console.error('PRIVATE_KEY not set');
        process.exit(1);
    }

    const provider = new ethers.providers.JsonRpcProvider(RPC_URL);
    const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
    console.log('Pool Swap Test — Base (via Uniswap SwapRouter02)');
    console.log('Wallet:', wallet.address);
    console.log('');

    const poolAbi = [
        'function slot0() external view returns (uint160 sqrtPriceX96,int24 tick,uint16 observationIndex,uint16 observationCardinality,uint16 observationCardinalityNext,uint8 feeProtocol,bool unlocked)',
        'function liquidity() external view returns (uint128)',
        'function token0() external view returns (address)',
        'function token1() external view returns (address)'
    ];
    const erc20Abi = [
        'function balanceOf(address) external view returns (uint256)',
        'function approve(address spender, uint256 amount) external returns (bool)',
        'function allowance(address owner, address spender) external view returns (uint256)',
        'function decimals() external view returns (uint8)',
        'function symbol() external view returns (string)'
    ];
    // SwapRouter02 exactInputSingle — 7-field struct, no deadline field
    const routerAbi = [
        'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) external payable returns (uint256 amountOut)'
    ];

    const pool = new ethers.Contract(POOL_ADDRESS, poolAbi, provider);
    const cbbtc = new ethers.Contract(QQQB_ADDRESS, erc20Abi, wallet);
    const wsxmr = new ethers.Contract(WSXMR_ADDRESS, erc20Abi, wallet);
    const router = new ethers.Contract(UNI_SWAP_ROUTER, routerAbi, wallet);

    const slot0 = await pool.slot0();
    const liquidity = await pool.liquidity();
    const token0 = await pool.token0();
    const token1 = await pool.token1();

    console.log('Pool:', POOL_ADDRESS, '(fee', POOL_FEE + ')');
    console.log('  tick:', slot0.tick);
    console.log('  liquidity:', liquidity.toString());
    console.log('  token0:', token0, '| token1:', token1);
    console.log('  Router:', UNI_SWAP_ROUTER);
    console.log('');

    const wsxmrBal = await wsxmr.balanceOf(wallet.address);
    const cbbtcBal = await cbbtc.balanceOf(wallet.address);
    const wsxmrDec = await wsxmr.decimals();
    const cbbtcDec = await cbbtc.decimals();
    console.log('Wallet:  wsXMR', ethers.utils.formatUnits(wsxmrBal, wsxmrDec), '| cbBTC', ethers.utils.formatUnits(cbbtcBal, cbbtcDec));
    console.log('');

    const MIN_LIQ = ethers.BigNumber.from('1000000');
    if (liquidity.lt(MIN_LIQ)) {
        console.log('WARNING: pool liquidity is very low — swaps will move price heavily or revert.\n');
    }

    // --- Swap 1: wsXMR -> cbBTC ---
    if (wsxmrBal.gt(1000)) {
        const amountIn = ethers.BigNumber.from('1000'); // 0.00001 wsXMR
        console.log('Swap 1: wsXMR -> cbBTC, amount in:', ethers.utils.formatUnits(amountIn, wsxmrDec));
        const allowance = await wsxmr.allowance(wallet.address, UNI_SWAP_ROUTER);
        if (allowance.lt(amountIn)) {
            await (await wsxmr.approve(UNI_SWAP_ROUTER, ethers.constants.MaxUint256)).wait();
            console.log('  Approved router for wsXMR');
        }
        const cbbtcBefore = await cbbtc.balanceOf(wallet.address);
        const tx = await router.exactInputSingle({
            tokenIn: WSXMR_ADDRESS,
            tokenOut: QQQB_ADDRESS,
            fee: POOL_FEE,
            recipient: wallet.address,
            amountIn,
            amountOutMinimum: 0,
            sqrtPriceLimitX96: 0
        }, { gasLimit: 1200000 });
        await tx.wait();
        const cbbtcAfter = await cbbtc.balanceOf(wallet.address);
        console.log('  TX:', tx.hash);
        console.log('  ' + EXPLORER + '/tx/' + tx.hash);
        console.log('  cbBTC received:', ethers.utils.formatUnits(cbbtcAfter.sub(cbbtcBefore), cbbtcDec));
        console.log('');
    } else {
        console.log('Skip swap 1: not enough wsXMR\n');
    }

    // --- Swap 2: cbBTC -> wsXMR ---
    const cbbtcBal2 = await cbbtc.balanceOf(wallet.address);
    const cbbtcIn = ethers.utils.parseUnits('0.000005', cbbtcDec); // ~$0.40 cbBTC
    if (cbbtcBal2.gte(cbbtcIn)) {
        console.log('Swap 2: cbBTC -> wsXMR, amount in:', ethers.utils.formatUnits(cbbtcIn, cbbtcDec));
        const allowance = await cbbtc.allowance(wallet.address, UNI_SWAP_ROUTER);
        if (allowance.lt(cbbtcIn)) {
            await (await cbbtc.approve(UNI_SWAP_ROUTER, ethers.constants.MaxUint256)).wait();
            console.log('  Approved router for cbBTC');
        }
        const wsxmrBefore = await wsxmr.balanceOf(wallet.address);
        const tx = await router.exactInputSingle({
            tokenIn: QQQB_ADDRESS,
            tokenOut: WSXMR_ADDRESS,
            fee: POOL_FEE,
            recipient: wallet.address,
            amountIn: cbbtcIn,
            amountOutMinimum: 0,
            sqrtPriceLimitX96: 0
        }, { gasLimit: 1200000 });
        await tx.wait();
        const wsxmrAfter = await wsxmr.balanceOf(wallet.address);
        console.log('  TX:', tx.hash);
        console.log('  ' + EXPLORER + '/tx/' + tx.hash);
        console.log('  wsXMR received:', ethers.utils.formatUnits(wsxmrAfter.sub(wsxmrBefore), wsxmrDec));
        console.log('');
    } else {
        console.log('Skip swap 2: not enough cbBTC\n');
    }

    console.log('Pool swap test complete');
}

main().catch(err => { console.error(err); process.exit(1); });
