#!/usr/bin/env node
/**
 * Volume generator for the USDe/wsXMR HyperSwap pool.
 * Alternates USDe->wsXMR (buy) and wsXMR->USDe (sell) legs through SwapHelper,
 * recycling the same capital so cumulative swap volume builds without needing
 * a large balance. Each round costs ~0.6% in pool fees plus gas.
 *
 * Env: ROUNDS (default 15), MAX_LEG_USDE (default 3), MIN_LEG_USDE (default 1),
 *      SLEEP_MS (default 2500), PRIVATE_KEY (required).
 * Run from repo root: node ethereum/scripts/poolVolume.hyperevm.js
 */
require('dotenv').config();
const { ethers } = require('ethers');
const { getWallet, getContracts, send, sendRetry, cfg } = require('./hyperevmLib');

const POOL_ABI = [
    'function token0() external view returns (address)',
    'function liquidity() external view returns (uint128)'
];
const SWAPHELPER_ABI = [
    'function swap(address pool, address recipient, bool zeroForOne, int256 amountSpecified, uint160 sqrtPriceLimitX96) external returns (int256,int256)'
];

const ROUNDS = parseInt(process.env.ROUNDS || '15', 10);
const MAX_LEG_USDE = parseFloat(process.env.MAX_LEG_USDE || '3');
const MIN_LEG_USDE = parseFloat(process.env.MIN_LEG_USDE || '1');
const SLEEP_MS = parseInt(process.env.SLEEP_MS || '2500', 10);

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const rand = (min, max) => min + Math.random() * (max - min);

async function main() {
    const { provider, wallet } = getWallet();
    const c = getContracts(wallet, provider);
    const pool = new ethers.Contract(cfg.POOL_ADDRESS, POOL_ABI, provider);
    const swapHelper = new ethers.Contract(cfg.SWAP_HELPER, SWAPHELPER_ABI, wallet);
    const usdeDec = await c.usde.decimals();

    const token0 = await pool.token0();
    const usdeIsToken0 = token0.toLowerCase() === cfg.USDE_ADDRESS.toLowerCase();
    const liquidity = await pool.liquidity();
    console.log('Pool volume generator —', wallet.address);
    console.log('Pool:', cfg.POOL_ADDRESS, '| liquidity:', liquidity.toString(), '| USDe is token0:', usdeIsToken0);
    if (liquidity.lt(1000000)) { console.error('Pool has no liquidity — aborting'); process.exit(1); }

    // One-time max approvals — avoids an approval tx per leg
    const MAX = ethers.constants.MaxUint256;
    await send(c.usde.approve(cfg.SWAP_HELPER, MAX), 'usde.approve');
    await send(c.wsxmr.approve(cfg.SWAP_HELPER, MAX), 'wsxmr.approve');

    let volumeUsde = 0;
    let round = 0;
    while (round < ROUNDS) {
        round++;
        const usdeBal = await c.usde.balanceOf(wallet.address);
        const usdeAvail = parseFloat(ethers.utils.formatUnits(usdeBal, usdeDec));
        const legUsde = Math.min(rand(MIN_LEG_USDE, MAX_LEG_USDE), usdeAvail * 0.5);
        if (legUsde < 0.01) { console.log(`Round ${round}: USDe too low (${usdeAvail.toFixed(4)}) — stopping`); break; }

        // BUY: USDe -> wsXMR (zeroForOne when USDe is token0)
        const amtIn = ethers.utils.parseUnits(legUsde.toFixed(usdeDec > 6 ? 6 : usdeDec), usdeDec);
        const before = await c.wsxmr.balanceOf(wallet.address);
        const rc1 = await sendRetry(
            () => swapHelper.swap(cfg.POOL_ADDRESS, wallet.address, usdeIsToken0, amtIn, 0, { gasLimit: 800000 }),
            `buy#${round}`
        );
        const got = (await c.wsxmr.balanceOf(wallet.address)).sub(before);
        volumeUsde += legUsde;
        console.log(`Round ${round} BUY : ${legUsde.toFixed(4)} USDe -> ${ethers.utils.formatUnits(got, 8)} wsXMR | ${rc1.transactionHash.slice(0, 18)}...`);
        await sleep(SLEEP_MS);

        // SELL: the exact wsXMR just received -> USDe
        if (got.gt(10)) {
            const before2 = await c.usde.balanceOf(wallet.address);
            const rc2 = await sendRetry(
                () => swapHelper.swap(cfg.POOL_ADDRESS, wallet.address, !usdeIsToken0, got, 0, { gasLimit: 800000 }),
                `sell#${round}`
            );
            const back = (await c.usde.balanceOf(wallet.address)).sub(before2);
            volumeUsde += parseFloat(ethers.utils.formatUnits(back, usdeDec));
            console.log(`Round ${round} SELL: ${ethers.utils.formatUnits(got, 8)} wsXMR -> ${ethers.utils.formatUnits(back, usdeDec)} USDe | ${rc2.transactionHash.slice(0, 18)}...`);
            await sleep(SLEEP_MS);
        }
        console.log(`  cumulative volume ≈ $${volumeUsde.toFixed(2)} | USDe left: ${usdeAvail.toFixed(4)}`);
    }

    console.log(`\nDone. ${round} rounds, ≈ $${volumeUsde.toFixed(2)} cumulative volume`);
    console.log(`${cfg.EXPLORER}/address/${wallet.address}`);
}
main().catch(e => { console.error(e); process.exit(1); });
