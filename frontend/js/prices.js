// Display-only market prices (XMR-USD, collateral-USD).
//
// The protocol is oracle-free: no transaction path, capacity check, or
// settlement ever reads these values. They exist purely for UI context —
// vault cards, peg displays, preview math. LP-declared thresholds and
// market-discovered prices are the only rates the contracts honor.
//
// Sources (in order): Yahoo Finance quote endpoints, then CoinGecko.
// Per-chain collateral tickers live in CHAINS[key].collateral.priceProxy.

import { getActiveChain } from './config.js?v=3.59';

// Default proxy tickers per collateral symbol — override via
// CHAINS[key].collateral.priceProxy = { yahoo, coingecko }.
const DEFAULT_PROXIES = {
    QQQB: { yahoo: 'QQQ', coingecko: null },               // QQQ ETF proxy
    cbBTC: { yahoo: 'BTC-USD', coingecko: 'bitcoin' },
    SPY: { yahoo: 'SPY', coingecko: null },
    sDAI: { yahoo: null, coingecko: 'dai' },
    DAI: { yahoo: null, coingecko: 'dai' },
};
const XMR_PROXIES = { yahoo: 'XMR-USD', coingecko: 'monero' };

let _cache = null;   // { xmr, coll, src }
let _cacheAt = 0;
const CACHE_MS = 45000;

function proxies() {
    const c = getActiveChain()?.collateral;
    const override = c?.priceProxy || {};
    const def = DEFAULT_PROXIES[c?.symbol] || {};
    return {
        xmrYahoo: XMR_PROXIES.yahoo,
        xmrCg: XMR_PROXIES.coingecko,
        collYahoo: override.yahoo ?? def.yahoo ?? null,
        collCg: override.coingecko ?? def.coingecko ?? null,
    };
}

async function yahooPrice(symbol) {
    const res = await fetch(
        `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`,
        { signal: AbortSignal.timeout(8000) }
    );
    if (!res.ok) throw new Error(`Yahoo HTTP ${res.status}`);
    const j = await res.json();
    const p = j?.chart?.result?.[0]?.meta?.regularMarketPrice;
    if (!p) throw new Error(`no Yahoo price for ${symbol}`);
    return p;
}

async function cgPrices(ids) {
    const res = await fetch(
        `https://api.coingecko.com/api/v3/simple/price?ids=${ids.join(',')}&vs_currencies=usd`,
        { signal: AbortSignal.timeout(8000) }
    );
    if (!res.ok) throw new Error(`CoinGecko HTTP ${res.status}`);
    const j = await res.json();
    return ids.map(id => j[id]?.usd);
}

/**
 * Fetch display prices for the active chain.
 * Returns { xmr, coll, src } in USD (coll may be null when the asset has no
 * public proxy), or null when every source fails. Cached ~45s.
 */
export async function fetchDisplayPrices() {
    if (_cache && Date.now() - _cacheAt < CACHE_MS) return _cache;
    const { xmrYahoo, xmrCg, collYahoo, collCg } = proxies();

    // Yahoo: one call per symbol.
    try {
        const xmr = await yahooPrice(xmrYahoo);
        const coll = collYahoo ? await yahooPrice(collYahoo) : null;
        if (xmr) {
            _cache = { xmr, coll, src: 'yahoo' };
            _cacheAt = Date.now();
            return _cache;
        }
    } catch (e) { /* fall through to CoinGecko */ }

    try {
        const ids = [xmrCg];
        if (collCg) ids.push(collCg);
        const [xmr, coll] = await cgPrices(ids);
        if (xmr) {
            _cache = { xmr, coll: coll ?? null, src: 'coingecko' };
            _cacheAt = Date.now();
            return _cache;
        }
    } catch (e) { /* exhausted */ }

    _cache = null;
    return null;
}

/** XMR-USD only — cheap single-symbol helper for quote previews. */
export async function fetchXmrUsd() {
    const p = await fetchDisplayPrices();
    return p ? p.xmr : null;
}
