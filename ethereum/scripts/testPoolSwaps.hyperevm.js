#!/usr/bin/env node
/**
 * Both-direction swaps on the USDe/wsXMR HyperSwap pool via SwapHelper.
 * Seeds the pool via Co-LP if empty (auto-buys USDe + mints wsXMR).
 */
require('dotenv').config();
const { ethers } = require('ethers');
const { getWallet, getContracts, refreshPrices, ensureVault, mintWsXMR, send, sendRetry, cfg } = require('./hyperevmLib');

const POOL_FEE = 3000;
const POOL_ABI = [
    'function slot0() external view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)',
    'function liquidity() external view returns (uint128)',
    'function token0() external view returns (address)',
    'function token1() external view returns (address)'
];
const SWAPHELPER_ABI = ['function swap(address pool, address recipient, bool zeroForOne, int256 amountSpecified, uint160 sqrtPriceLimitX96) external returns (int256,int256)'];
const NFPM_ABI = [
    'function balanceOf(address) external view returns (uint256)',
    'function tokenOfOwnerByIndex(address,uint256) external view returns (uint256)',
    'function positions(uint256) external view returns (uint96,address,address,address,uint24,int24,int24,uint128,uint256,uint256,uint128,uint128)'
];

async function main() {
    const { provider, wallet } = getWallet();
    const c = getContracts(wallet, provider);
    console.log('Pool Swaps (HyperEVM) —', wallet.address, '\n');

    const poolAddr = cfg.POOL_ADDRESS;
    const pool = new ethers.Contract(poolAddr, POOL_ABI, provider);
    const swapHelper = new ethers.Contract(cfg.SWAP_HELPER, SWAPHELPER_ABI, wallet);
    const nfpm = new ethers.Contract(cfg.HYPERSWAP_NFPM, NFPM_ABI, provider);

    const slot0 = await pool.slot0();
    let liquidity = await pool.liquidity();
    const token0 = await pool.token0();
    console.log('Pool:', poolAddr, '| tick:', slot0[1], '| liquidity:', liquidity.toString());

    // Seed via Co-LP if empty
    if (liquidity.lt(1000000)) {
        console.log('Pool empty — seeding via Co-LP (auto-buy USDe + mint wsXMR)');
        await ensureVault(wallet, c, ethers.utils.parseEther('0.5'));
        let bal = await c.wsxmr.balanceOf(wallet.address);
        if (bal.lt(20000)) { await mintWsXMR(wallet, c, ethers.BigNumber.from('200000000')); bal = await c.wsxmr.balanceOf(wallet.address); }
        const seedAmt = ethers.utils.parseUnits('0.0001', 8);
        if (bal.gte(seedAmt)) {
            await send(c.wsxmr.approve(cfg.HUB_ADDRESS, seedAmt), 'wsxmr.approve');
            await refreshPrices(c.hub);
            await sendRetry(() => c.hub.userOpenCoLP(wallet.address, seedAmt, Math.floor(Date.now()/1000)+3600, { gasLimit: 2000000 }), 'userOpenCoLP');
            liquidity = await pool.liquidity();
            console.log('  seeded. liquidity:', liquidity.toString());
        }
    }

    const usdeBal = await c.usde.balanceOf(wallet.address);
    const wsxmrBal = await c.wsxmr.balanceOf(wallet.address);
    const usdeDec = await c.usde.decimals();
    console.log('Balances: USDe', ethers.utils.formatUnits(usdeBal, usdeDec), '| wsXMR', ethers.utils.formatUnits(wsxmrBal, 8));
    const wsxmrIsToken0 = token0.toLowerCase() === cfg.WSXMR_ADDRESS.toLowerCase();
    console.log('wsXMR is token0:', wsxmrIsToken0, '\n');

    // Swap 1: wsXMR -> USDe
    if (liquidity.gte(1000000) && wsxmrBal.gt(10)) {
        const amt = ethers.BigNumber.from('1000');
        await send(c.wsxmr.approve(cfg.SWAP_HELPER, amt), 'wsxmr.approve');
        const before = await c.usde.balanceOf(wallet.address);
        const rc = await sendRetry(() => swapHelper.swap(poolAddr, wallet.address, wsxmrIsToken0, amt, 0, { gasLimit: 800000 }), 'swap1');
        const after = await c.usde.balanceOf(wallet.address);
        console.log('Swap1 wsXMR->USDe:', ethers.utils.formatUnits(after.sub(before), usdeDec), 'USDe |', rc.transactionHash);
    } else console.log('Skip swap1 (low liquidity / no wsXMR)');

    // Swap 2: USDe -> wsXMR
    const usdeBal2 = await c.usde.balanceOf(wallet.address);
    if (liquidity.gte(1000000) && usdeBal2.gt(ethers.utils.parseUnits('0.001', usdeDec))) {
        const amt = ethers.utils.parseUnits('0.001', usdeDec);
        await send(c.usde.approve(cfg.SWAP_HELPER, amt), 'usde.approve');
        const before = await c.wsxmr.balanceOf(wallet.address);
        const rc = await sendRetry(() => swapHelper.swap(poolAddr, wallet.address, !wsxmrIsToken0, amt, 0, { gasLimit: 800000 }), 'swap2');
        const after = await c.wsxmr.balanceOf(wallet.address);
        console.log('Swap2 USDe->wsXMR:', ethers.utils.formatUnits(after.sub(before), 8), 'wsXMR |', rc.transactionHash);
    } else console.log('Skip swap2 (low liquidity / no USDe)');

    // Co-LP fee collection
    const routerAddr = await c.hub.liquidityRouter();
    const n = await nfpm.balanceOf(routerAddr);
    let tokenId = null;
    for (let i = n.toNumber()-1; i >= 0 && !tokenId; i--) {
        const tid = await nfpm.tokenOfOwnerByIndex(routerAddr, i);
        const p = await nfpm.positions(tid);
        const match = [p[2].toLowerCase(), p[3].toLowerCase()].sort().join() === [cfg.USDE_ADDRESS.toLowerCase(), cfg.WSXMR_ADDRESS.toLowerCase()].sort().join();
        if (match && p[7].gt(0)) tokenId = tid;
    }
    if (tokenId) {
        const before = await nfpm.positions(tokenId);
        console.log('\nCo-LP tokenId', tokenId.toString(), 'fees owed:', before[10].toString(), '/', before[11].toString());
        try { await sendRetry(() => c.hub.collectCoLPFees(tokenId, { gasLimit: 1000000 }), 'collectCoLPFees'); console.log('fees collected'); }
        catch(e){ console.log('collect failed:', e.message.split('\n')[0]); }
    } else console.log('\nNo Co-LP position to collect from');

    console.log('\nPool swap test complete —', `${cfg.EXPLORER}/address/${wallet.address}`);
}
main().catch(e => { console.error(e); process.exit(1); });
