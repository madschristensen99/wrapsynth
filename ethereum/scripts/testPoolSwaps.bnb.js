#!/usr/bin/env node
/**
 * Test swaps on the live wsXMR/QQQB PancakeSwap V3 pool (BNB Chain).
 * Routes through the PancakeSwap Smart Router — the same path real users take.
 */

require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const { ethers } = require('ethers');
const { WSXMR_ADDRESS, QQQB_ADDRESS, POOL_ADDRESS, PCS_SMART_ROUTER, RPC_URL } = require('./deploymentConfig.bnb');

const POOL_FEE = 500;

async function main() {
    if (!process.env.PRIVATE_KEY) {
        console.error('PRIVATE_KEY not set');
        process.exit(1);
    }

    const provider = new ethers.providers.JsonRpcProvider(RPC_URL);
    // Pin fees near the BSC floor — this RPC over-reports fee data (1.5 gwei vs ~0.05 actual)
    const floor = ethers.utils.parseUnits('0.1', 'gwei');
    provider.getFeeData = async () => ({
        gasPrice: floor, maxFeePerGas: floor, maxPriorityFeePerGas: floor, lastBaseFeePerGas: floor
    });
    const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
    console.log('Pool Swap Test — BNB Chain (via PancakeSwap Smart Router)');
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
    const routerAbi = [
        'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) external payable returns (uint256 amountOut)'
    ];

    const pool = new ethers.Contract(POOL_ADDRESS, poolAbi, provider);
    const qqqb = new ethers.Contract(QQQB_ADDRESS, erc20Abi, wallet);
    const wsxmr = new ethers.Contract(WSXMR_ADDRESS, erc20Abi, wallet);
    const router = new ethers.Contract(PCS_SMART_ROUTER, routerAbi, wallet);

    const slot0 = await pool.slot0();
    const liquidity = await pool.liquidity();
    const token0 = await pool.token0();
    const token1 = await pool.token1();

    console.log('Pool:', POOL_ADDRESS, '(fee', POOL_FEE + ')');
    console.log('  tick:', slot0.tick);
    console.log('  liquidity:', liquidity.toString());
    console.log('  token0:', token0, '| token1:', token1);
    console.log('  Router:', PCS_SMART_ROUTER);
    console.log('');

    const wsxmrBal = await wsxmr.balanceOf(wallet.address);
    const qqqbBal = await qqqb.balanceOf(wallet.address);
    const wsxmrDec = await wsxmr.decimals();
    const qqqbDec = await qqqb.decimals();
    console.log('Wallet:  wsXMR', ethers.utils.formatUnits(wsxmrBal, wsxmrDec), '| QQQB', ethers.utils.formatUnits(qqqbBal, qqqbDec));
    console.log('');

    const MIN_LIQ = ethers.BigNumber.from('1000000');
    if (liquidity.lt(MIN_LIQ)) {
        console.log('WARNING: pool liquidity is very low — swaps will move price heavily or revert.\n');
    }

    const deadline = Math.floor(Date.now() / 1000) + 3600;

    // --- Swap 1: wsXMR -> QQQB ---
    if (wsxmrBal.gt(1000)) {
        const amountIn = ethers.BigNumber.from('1000'); // 0.00001 wsXMR
        console.log('Swap 1: wsXMR -> QQQB, amount in:', ethers.utils.formatUnits(amountIn, wsxmrDec));
        const allowance = await wsxmr.allowance(wallet.address, PCS_SMART_ROUTER);
        if (allowance.lt(amountIn)) {
            await (await wsxmr.approve(PCS_SMART_ROUTER, ethers.constants.MaxUint256)).wait();
            console.log('  Approved router for wsXMR');
        }
        const qqqbBefore = await qqqb.balanceOf(wallet.address);
        const tx = await router.exactInputSingle({
            tokenIn: WSXMR_ADDRESS,
            tokenOut: QQQB_ADDRESS,
            fee: POOL_FEE,
            recipient: wallet.address,
            deadline,
            amountIn,
            amountOutMinimum: 0,
            sqrtPriceLimitX96: 0
        }, { gasLimit: 3500000 });
        await tx.wait();
        const qqqbAfter = await qqqb.balanceOf(wallet.address);
        console.log('  TX:', tx.hash);
        console.log('  https://bscscan.com/tx/' + tx.hash);
        console.log('  QQQB received:', ethers.utils.formatUnits(qqqbAfter.sub(qqqbBefore), qqqbDec));
        console.log('');
    } else {
        console.log('Skip swap 1: not enough wsXMR\n');
    }

    // --- Swap 2: QQQB -> wsXMR ---
    const qqqbBal2 = await qqqb.balanceOf(wallet.address);
    const qqqbIn = ethers.utils.parseUnits('0.0001', qqqbDec); // ~$0.07 QQQB
    if (qqqbBal2.gte(qqqbIn)) {
        console.log('Swap 2: QQQB -> wsXMR, amount in:', ethers.utils.formatUnits(qqqbIn, qqqbDec));
        const allowance = await qqqb.allowance(wallet.address, PCS_SMART_ROUTER);
        if (allowance.lt(qqqbIn)) {
            await (await qqqb.approve(PCS_SMART_ROUTER, ethers.constants.MaxUint256)).wait();
            console.log('  Approved router for QQQB');
        }
        const wsxmrBefore = await wsxmr.balanceOf(wallet.address);
        const tx = await router.exactInputSingle({
            tokenIn: QQQB_ADDRESS,
            tokenOut: WSXMR_ADDRESS,
            fee: POOL_FEE,
            recipient: wallet.address,
            deadline,
            amountIn: qqqbIn,
            amountOutMinimum: 0,
            sqrtPriceLimitX96: 0
        }, { gasLimit: 3500000 });
        await tx.wait();
        const wsxmrAfter = await wsxmr.balanceOf(wallet.address);
        console.log('  TX:', tx.hash);
        console.log('  https://bscscan.com/tx/' + tx.hash);
        console.log('  wsXMR received:', ethers.utils.formatUnits(wsxmrAfter.sub(wsxmrBefore), wsxmrDec));
        console.log('');
    } else {
        console.log('Skip swap 2: not enough QQQB\n');
    }

    console.log('Pool swap test complete');
}

main().catch(err => { console.error(err); process.exit(1); });
