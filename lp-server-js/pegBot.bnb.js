/**
 * pegBot.bnb.js — wsXMR/QQQB pool price tracker on BNB Chain (internal tool, gitignored).
 *
 * Port of pegBot.base.js. Differences vs Base:
 *   - token0 = QQQB (18 dec), token1 = wsXMR (8 dec) — opposite of Base.
 *   - Router is PancakeSwap SmartRouter; exactInputSingle takes a `deadline`.
 *   - Collateral price = QQQ (Yahoo primary). CoinGecko has no QQQB id, so the
 *     coingecko fallback uses the QQQ ETF proxy.
 *
 * Pool math: sqrtP^2 = raw token1/token0 = wsxmr_raw / qqqb_raw.
 *   wsxmr_per_qqqb (human) = (sqrtP/2^96)^2 * 10^(18-8) = price0 * 1e10
 *   target: wsxmr_per_qqqb = qqqbUsd / xmrUsd
 *   => price0_target = (qqqbUsd/xmrUsd) / 1e10
 *
 * Direction (cur vs tgt on sqrtP):
 *   cur < tgt -> wsXMR overpriced -> sell wsXMR (token1) for QQQB, price up
 *   cur > tgt -> wsXMR underpriced -> sell QQQB (token0) for wsXMR, price down
 *
 * Run:  node pegBot.bnb.js       (uses PRIVATE_KEY + RPC from .env)
 * Env overrides: BNB_RPC_URLS, PEG_INTERVAL_MS, PEG_DRIFT_BPS, PEG_MAX_TRADE_PCT
 */

import 'dotenv/config';
import { ethers } from 'ethers';

// ---- config ----------------------------------------------------------------
const RPC_URLS = (process.env.BNB_RPC_URLS || 'https://bsc-dataseed.bnbchain.org').split(',').map(s => s.trim()).filter(Boolean);
const POOL         = '0xb194431E130faF842d8f530316a9D1653091e4d4';
const ROUTER       = '0x1b81D678ffb9C0263b24A97847620C99d213eB14'; // PancakeSwap SmartRouter
const WSXMR        = '0x71FeC2287DaAB5bf6d6bF76Ed817067E201Fb894'; // token1, 8 dec
const QQQB         = '0x205812CdBed920aFf76C6580abD681a46D11efc7'; // token0, 18 dec

const INTERVAL_MS   = Number(process.env.PEG_INTERVAL_MS || 10000);
const DRIFT_BPS     = Number(process.env.PEG_DRIFT_BPS || 30);      // 0.3%
const HEARTBEAT_TICKS = 6;                                         // status line every ~1 min
const MAX_TRADE_PCT = Number(process.env.PEG_MAX_TRADE_PCT || 90);  // % of balance per trade
const MIN_BNB       = ethers.parseEther('0.001');
const GAS_LIMIT     = 3000000n;
const Q96           = 1n << 96n;
const DEC_GAP       = 10n ** 10n;   // 10^(qqqbDec - wsxmrDec) = 1e10

// ---- contracts -------------------------------------------------------------
const provider = new ethers.JsonRpcProvider(RPC_URLS[0]);
const wallet   = new ethers.Wallet(process.env.PRIVATE_KEY, provider);


// Live USD prices for the peg bot from off-chain sources (Yahoo primary,
// CoinGecko fallback). QQQB tracks QQQ 1:1 (bStocks) — QQQ is the proxy.
const YAHOO_SYM = { xmr: 'XMR-USD', coll: 'QQQ' };
const CG_IDS = { xmr: 'monero', coll: 'invesco-qqq-trust' };
let cgCache = null;
let cgAt = 0;
async function yahooPrice(symbol) {
    const res = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&range=1d`, {
        signal: AbortSignal.timeout(8000), headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    const j = await res.json();
    const p = j?.chart?.result?.[0]?.meta?.regularMarketPrice;
    if (!p) throw new Error(`no Yahoo price for ${symbol}`);
    return p;
}
async function fetchLivePrices() {
    if (cgCache && Date.now() - cgAt < 45000) return cgCache;
    const attempts = [
        ['yahoo', async () => ({ xmr: await yahooPrice(YAHOO_SYM.xmr), coll: await yahooPrice(YAHOO_SYM.coll) })],
        ['coingecko', async () => {
            const res = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${CG_IDS.xmr},${CG_IDS.coll}&vs_currencies=usd`, { signal: AbortSignal.timeout(8000) });
            const j = await res.json();
            const x = j[CG_IDS.xmr]?.usd, c = j[CG_IDS.coll]?.usd;
            if (!x || !c) throw new Error('incomplete CoinGecko response');
            return { xmr: x, coll: c };
        }],
    ];
    for (const [src, fn] of attempts) {
        try {
            const p = await fn();
            if (p.xmr && p.coll) { cgCache = p; cgCache.src = src; cgAt = Date.now(); return cgCache; }
        } catch (e) { /* try next */ }
    }
    cgCache = null;
    return null;
}

const pool = new ethers.Contract(POOL, [
    'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)',
    'function liquidity() view returns (uint128)',
], provider);

const router = new ethers.Contract(ROUTER, [
    'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) external payable returns (uint256 amountOut)',
], wallet);

const erc20 = (a) => new ethers.Contract(a, [
    'function balanceOf(address) view returns (uint256)',
    'function approve(address, uint256) returns (bool)',
], wallet);
const wsxmr = erc20(WSXMR);
const qqqb  = erc20(QQQB);

// ---- math ------------------------------------------------------------------
function isqrt(n) {
    if (n < 2n) return n;
    let x = n, y = (x + 1n) >> 1n;
    while (y < x) { x = y; y = (x + n / x) >> 1n; }
    return x;
}

// price0 = (sqrtP/2^96)^2 = raw token1/token0 = wsxmr_raw / qqqb_raw
// wsxmr_per_qqqb (human) = price0 * 1e10
// Peg: wsxmr_per_qqqb = qqqbUsd / xmrUsd  =>  price0_target = (qqqbUsd/xmrUsd)/1e10
// Work in 1e8-scaled USD prices. price0_target = collP/xmrP / 1e10 — keep the
// 1e10 inside the isqrt argument by scaling prices instead:
//   targetSqrt = sqrt( (collP/xmrP) / 1e10 ) * 2^96
// Rearranged to integer math: sqrt( collP * Q96^2 / (xmrP * 1e10) )
function targetSqrt(xmrPrice, collPrice) {
    return isqrt(collPrice * Q96 * Q96 / (xmrPrice * DEC_GAP));
}

// amountIn needed to move sqrtP from cur to tgt through liquidity L.
// up (pay t1, zeroForOne=false): amt1 = L * (tgt - cur) / 2^96
// down (pay t0, zeroForOne=true): amt0 = L * 2^96 * (1/tgt - 1/cur)
function neededIn(up, L, cur, tgt) {
    if (L === 0n) return 1n; // empty range walks free; dust is enough
    if (up) return L * (tgt - cur) / Q96;
    return L * Q96 * (cur - tgt) / (cur * tgt / Q96);
}

// ---- loop ------------------------------------------------------------------
let busy = false;
let tickCount = 0;

async function tick() {
    if (busy) return;
    busy = true;
    tickCount++;
    try {
        const live = await fetchLivePrices();
        if (!live) { console.log('[peg] no live price — skipping'); return; }
        const xmrP = BigInt(Math.round(live.xmr * 1e8));
        const collP = BigInt(Math.round(live.coll * 1e8));
        const src = live.src || 'live';
        const [slot, L] = await Promise.all([pool.slot0(), pool.liquidity()]);
        if (xmrP === 0n || collP === 0n) { console.log('[peg] live price zero — skipping'); return; }

        const cur = BigInt(slot[0]);
        const tgt = targetSqrt(xmrP, collP);
        const drift = Number((cur > tgt ? cur - tgt : tgt - cur) * 10000n / tgt); // bps

        if (drift < DRIFT_BPS) {
            if (tickCount % HEARTBEAT_TICKS === 0) {
                console.log(`[peg] ok — drift ${drift}bps (<${DRIFT_BPS}) | XMR $${Number(xmrP) / 1e8} QQQ $${Number(collP) / 1e8} (${src}) | tick ${slot[1]}`);
            }
            return; // inside band
        }

        const bnb = await provider.getBalance(wallet.address);
        if (bnb < MIN_BNB) { console.log('[peg] LOW GAS:', ethers.formatEther(bnb), 'BNB — skipping'); return; }

        const up = cur < tgt; // sell wsXMR (token1) -> QQQB, price up
        const need = neededIn(up, BigInt(L), cur, tgt);
        const tok = up ? wsxmr : qqqb;
        const bal = await tok.balanceOf(wallet.address);
        const maxIn = bal * BigInt(MAX_TRADE_PCT) / 100n;
        const amtIn = need < maxIn ? need : maxIn;
        if (amtIn <= 0n) { console.log(`[peg] drift ${drift}bps but no ${up ? 'wsXMR' : 'QQQB'} balance — skipping`); return; }

        console.log(`[peg] drift ${drift}bps | sqrtP ${cur} -> tgt ${tgt} | ${up ? 'sell wsXMR (price up)' : 'sell QQQB (price down)'} amtIn=${amtIn} L=${L} | XMR $${Number(xmrP) / 1e8} QQQ $${Number(collP) / 1e8} (${src})`);

        // sqrtPriceLimitX96=tgt caps the fill at the target price.
        const tx = await router.exactInputSingle({
            tokenIn: up ? WSXMR : QQQB,
            tokenOut: up ? QQQB : WSXMR,
            fee: 500,
            recipient: wallet.address,
            deadline: Math.floor(Date.now() / 1000) + 600,
            amountIn: amtIn,
            amountOutMinimum: 0,
            sqrtPriceLimitX96: tgt,
        }, { gasLimit: GAS_LIMIT });
        console.log(`[peg] swap tx: ${tx.hash}`);
        const r = await tx.wait();
        const s = await pool.slot0();
        console.log(`[peg] done (gas ${r.gasUsed}) new tick ${s[1]} sqrtP ${s[0]}`);
    } catch (e) {
        console.log('[peg] error:', (e.shortMessage || e.message || '').slice(0, 160));
    } finally {
        busy = false;
    }
}

async function main() {
    if (!process.env.PRIVATE_KEY) { console.error('PRIVATE_KEY required in .env'); process.exit(1); }
    for (const t of [wsxmr, qqqb]) {
        try { await (await t.approve(ROUTER, ethers.MaxUint256)).wait(); }
        catch (e) { console.log('[peg] approve failed:', (e.shortMessage || '').slice(0, 80)); }
    }
    console.log(`[peg] tracking wsXMR/QQQB (BNB) -> oracle price | drift>${DRIFT_BPS}bps every ${INTERVAL_MS / 1000}s | wallet ${wallet.address}`);
    await tick();
    setInterval(tick, INTERVAL_MS);
}

main();
