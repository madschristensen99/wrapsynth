// landing.js — live data for the landing page (index.html).
//
// Iterates every deployed chain (via config.js manifests) and renders:
//   - aggregate protocol metrics (supply / TVL / CR / vaults)
//   - a per-chain live card: DexScreener price, peg premium vs the hub
//     oracle, pool liquidity, 24h volume, on-chain TVL/supply/vaults
//   - the Deployments contract cards (with per-chain funding hints)
//   - the live XMR price inside the timeline panel
//
// Everything is best-effort: a dead RPC or a DexScreener outage degrades
// that card to "--" rather than blanking the page. DexScreener responses
// are cached in sessionStorage and refreshed every REFRESH_MS.

import { CHAINS, loadDeployment } from './config.js?v=3.49';

const REFRESH_MS = 60_000;
const DEX_CACHE_MS = 60_000;

const getVaultAbi = [{
    name: 'getVault', type: 'function', stateMutability: 'view',
    inputs: [{ name: 'lpAddress', type: 'address' }],
    outputs: [{ type: 'tuple', components: [
        { name: 'lpAddress', type: 'address' },
        { name: 'collateralShares', type: 'uint256' },
        { name: 'lockedCollateral', type: 'uint256' },
        { name: 'normalizedDebt', type: 'uint256' },
        { name: 'pendingDebt', type: 'uint256' },
        { name: 'maxMintBps', type: 'uint16' },
        { name: 'mintGriefingDeposit', type: 'uint256' },
        { name: 'mintFeeBps', type: 'uint16' },
        { name: 'burnRewardBps', type: 'uint16' },
        { name: 'liquidationNonce', type: 'uint256' },
        { name: 'mintNonce', type: 'uint256' },
        { name: 'minBurnAmount', type: 'uint256' },
        { name: 'active', type: 'bool' },
        { name: 'deployedUSDeShares', type: 'uint256' },
        { name: 'maxCoLPRangeBps', type: 'uint16' },
        { name: 'mintTimeoutBlocks', type: 'uint256' },
        { name: 'burnTimeoutBlocks', type: 'uint256' },
        { name: 'pendingMintCount', type: 'uint256' }
    ]}]
}];

const state = {
    chains: {},   // key -> { cfg, D, client, onchain: {...}, dex: {...} }
    xmrUsd: 0,
};

function fmtUsd(v, dp = 2) {
    if (!isFinite(v)) return '--';
    if (v >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
    if (v >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
    return `$${v.toFixed(dp)}`;
}
function fmtNum(v, dp = 4) { return isFinite(v) ? v.toFixed(dp) : '--'; }

// ─── DexScreener ────────────────────────────────────────────────────────────

async function fetchDex(slug, pool) {
    const key = `dex:${slug}:${pool}`;
    try {
        const hit = JSON.parse(sessionStorage.getItem(key) || 'null');
        if (hit && Date.now() - hit.ts < DEX_CACHE_MS) return hit.pair;
    } catch (e) {}
    const res = await fetch(`https://api.dexscreener.com/latest/dex/pairs/${slug}/${pool}`, { signal: AbortSignal.timeout(9000) });
    const json = await res.json();
    const pair = (json.pairs || [])[0] || null;
    if (pair) { try { sessionStorage.setItem(key, JSON.stringify({ ts: Date.now(), pair })); } catch (e) {} }
    return pair;
}

// ─── On-chain reads ─────────────────────────────────────────────────────────

async function readChainStats(key, client, hub, wsXMR, parseAbi, formatUnits) {
    const out = { supply: 0, vaults: 0, tvlUsd: 0, debtUsd: 0, xmrUsd: 0 };
    const [supply, vaultCount] = await Promise.all([
        client.readContract({ address: wsXMR, abi: parseAbi(['function totalSupply() external view returns (uint256)']), functionName: 'totalSupply' }),
        client.readContract({ address: hub, abi: parseAbi(['function getVaultCount() external view returns (uint256)']), functionName: 'getVaultCount' })
    ]);
    out.supply = parseFloat(formatUnits(supply, 8));
    out.vaults = Number(vaultCount);

    let collateralShares = 0n, debt = 0n;
    for (let i = 0; i < out.vaults; i++) {
        const vaultAddr = await client.readContract({ address: hub, abi: parseAbi(['function vaultList(uint256) external view returns (address)']), functionName: 'vaultList', args: [BigInt(i)] });
        const [vault, vaultDebt] = await Promise.all([
            client.readContract({ address: hub, abi: getVaultAbi, functionName: 'getVault', args: [vaultAddr] }),
            client.readContract({ address: hub, abi: parseAbi(['function getVaultDebt(address) external view returns (uint256)']), functionName: 'getVaultDebt', args: [vaultAddr] })
        ]);
        collateralShares += vault.collateralShares;
        debt += vaultDebt;
    }

    // getXmrPrice/getCollateralPrice revert on StalePrice when no one has
    // pushed recently — last* return the stored values (1e8) unconditionally.
    let collateralPrice = 0;
    try {
        const raw = await client.readContract({ address: hub, abi: parseAbi(['function lastCollateralPrice() external view returns (uint256)']), functionName: 'lastCollateralPrice' });
        collateralPrice = parseFloat(formatUnits(raw, 8));
    } catch (e) { console.warn(`[Landing] ${key}: collateral price unavailable`); }
    try {
        const raw = await client.readContract({ address: hub, abi: parseAbi(['function lastXmrPrice() external view returns (uint256)']), functionName: 'lastXmrPrice' });
        out.xmrUsd = parseFloat(formatUnits(raw, 8));
    } catch (e) {}

    // Vault collateralShares are 18-dec share units; stata wrappers are 1:1
    // with underlying at a fixed SCALE, so shares * price = underlying value.
    out.tvlUsd = parseFloat(formatUnits(collateralShares, 18)) * collateralPrice;
    out.debtUsd = parseFloat(formatUnits(debt, 8)) * out.xmrUsd;
    return out;
}

// ─── Rendering ──────────────────────────────────────────────────────────────

function poolUrl(cfg, pool) {
    return cfg.dexscreenerSlug
        ? `https://dexscreener.com/${cfg.dexscreenerSlug}/${pool}`
        : `${cfg.explorer}/address/${pool}`;
}

// Chain logo + collateral-token logo as overlapping round badges
// (same visual idiom as the app's chain picker).
function iconPair(c, size = 22) {
    const badge = (src, letter, off) => src
        ? `<img src="${src}" alt="" style="width:${size}px;height:${size}px;border-radius:50%;object-fit:cover;${off}background:#222" onerror="this.outerHTML='<span style=&quot;display:inline-flex;width:${size}px;height:${size}px;border-radius:50%;background:#444;color:#fff;align-items:center;justify-content:center;font-size:${size * .55}px;font-weight:700;${off}&quot;>${letter}</span>'">`
        : `<span style="display:inline-flex;width:${size}px;height:${size}px;border-radius:50%;background:#444;color:#fff;align-items:center;justify-content:center;font-size:${size * .55}px;font-weight:700;${off}flex:none">${letter}</span>`;
    return `<span style="display:inline-flex;align-items:center;flex:none">${badge(c.chainIcon, c.name[0], '')}${badge(c.collateral.icon, c.collateral.symbol[0], 'margin-left:-7px;border:2px solid #161621;')}</span>`;
}

function renderChainCard(key) {
    const { cfg, D } = state.chains[key];
    const DC = D.contracts || D;
    const hub = DC.wsXmrHub, wsXMR = DC.wsXMR;
    const pool = (D.pool && D.pool.uniswapV3Pool) || D.pool;
    return `
    <div class="cchain" id="cchain-${key}">
      <div class="cchain-head">
        ${iconPair(cfg)}
        <b>${cfg.name}</b>
        <span class="badge">wsXMR ⇄ ${cfg.collateral.symbol}</span>
      </div>
      <div class="cprice">
        <span class="p" id="cp-${key}">--</span>
        <span class="prem" id="cm-${key}"></span>
      </div>
      <div class="crows">
        <div class="crow"><span>Pool liquidity</span><b id="cl-${key}">--</b></div>
        <div class="crow"><span>24h volume</span><b id="cv-${key}">--</b></div>
        <div class="crow"><span>24h swaps</span><b id="ct-${key}">--</b></div>
        <div class="crow"><span>wsXMR supply</span><b id="cs-${key}">--</b></div>
        <div class="crow"><span>Vault TVL</span><b id="ctv-${key}">--</b></div>
        <div class="crow"><span>Active vaults</span><b id="cav-${key}">--</b></div>
        <div class="crow"><span>Hub</span><b style="font-size:11px" title="${hub}">${hub.slice(0, 10)}…${hub.slice(-8)}</b></div>
      </div>
      <div class="cneed">${cfg.collateral.whatItIs || cfg.collateral.name} · ${cfg.acquire?.gasHint || ''}</div>
      <div class="clinks">
        ${pool ? `<a href="${poolUrl(cfg, pool)}" target="_blank" rel="noopener">Trade ↗</a>` : ''}
        <a href="${cfg.explorer}/address/${hub}" target="_blank" rel="noopener">Hub ↗</a>
        <a href="${cfg.explorer}/token/${wsXMR}" target="_blank" rel="noopener">wsXMR ↗</a>
        <a href="#" onclick="copyHubAddr('${hub}',this);return false">Copy</a>
        <a href="app.html?chain=${key}">Mint →</a>
      </div>
    </div>`;
}

window.copyHubAddr = function (addr, btn) {
    navigator.clipboard.writeText(addr).then(() => {
        const old = btn.textContent;
        btn.textContent = 'Copied ✓'; btn.style.color = 'var(--teal)';
        setTimeout(() => { btn.textContent = old; btn.style.color = ''; }, 1400);
    }).catch(() => {});
};

// Roadmap card — upcoming deployments that don't have a manifest yet.
function renderSoonCard() {
    return `
    <div class="cchain soon">
      <div class="cchain-head">
        ${iconPair({ chainIcon: 'assets/chains/solana.png', name: 'Solana', collateral: { icon: 'assets/tokens/sol.png', symbol: 'SOL' } })}
        <b>Solana</b>
        <span class="badge soon-badge">coming soon</span>
      </div>
      <div class="cprice"><span class="p">--</span><span class="prem">wsXMR ⇄ SOL</span></div>
      <div class="crows" style="margin-top:14px">
        <div class="crow"><span>Program (devnet)</span><b style="font-size:11px" title="k4TC3sLs4feJfuMYBf8piyRQMU1WENM2LbQoKJNWbmx">k4TC3sLs…NWbmx</b></div>
        <div class="crow"><span>wsXMR mint (devnet)</span><b style="font-size:11px" title="83wienN4RnKHFzSjPFXRpV8KuGYy9fyXMrekoXN6y9A6">83wienN4…9A6</b></div>
      </div>
      <div class="cneed" style="margin-top:12px">Port live on Solana devnet — same atomic-swap model, non-EVM. Mainnet is the next deployment target.</div>
      <div class="clinks">
        <a href="https://explorer.solana.com/address/k4TC3sLs4feJfuMYBf8piyRQMU1WENM2LbQoKJNWbmx?cluster=devnet" target="_blank" rel="noopener">Program ↗</a>
        <a href="https://explorer.solana.com/address/83wienN4RnKHFzSjPFXRpV8KuGYy9fyXMrekoXN6y9A6?cluster=devnet" target="_blank" rel="noopener">wsXMR ↗</a>
      </div>
    </div>`;
}


function applyDexToCard(key, pair) {
    const el = (id) => document.getElementById(id + key);
    if (!pair) return;
    const px = parseFloat(pair.priceUsd || 'NaN');
    if (el('cp-')) el('cp-').textContent = isFinite(px) ? `$${px.toFixed(2)}` : '--';
    if (el('cl-')) el('cl-').textContent = fmtUsd(parseFloat(pair.liquidity?.usd || 'NaN'));
    if (el('cv-')) el('cv-').textContent = fmtUsd(parseFloat(pair.volume?.h24 || 'NaN'));
    const t = pair.txns?.h24;
    if (el('ct-')) el('ct-').textContent = t ? String((t.buys || 0) + (t.sells || 0)) : '--';

    // Peg premium vs fresh XMR spot (hub's stored price as fallback)
    const oracle = state.xmrUsd || state.chains[key].onchain?.xmrUsd;
    const prem = el('cm-');
    if (prem && isFinite(px) && oracle > 0) {
        const pct = (px / oracle - 1) * 100;
        prem.textContent = `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}% vs oracle`;
        prem.className = 'prem ' + (Math.abs(pct) < 1 ? 'on' : pct > 0 ? 'hi' : 'lo');
    }
}

function applyOnchainToCard(key, s) {
    const el = (id) => document.getElementById(id + key);
    if (el('cs-')) el('cs-').textContent = s.supply < 0.01 ? s.supply.toFixed(8) : s.supply.toFixed(4);
    if (el('ctv-')) el('ctv-').textContent = fmtUsd(s.tvlUsd);
    if (el('cav-')) el('cav-').textContent = String(s.vaults);
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
    const { createPublicClient, http, formatUnits, parseAbi, fallback } =
        await import('https://esm.sh/viem@2.21.54');

    const live = document.getElementById('chain-live');

    for (const key of Object.keys(CHAINS)) {
        const cfg = CHAINS[key];
        const D = await loadDeployment(key).catch(() => null);
        if (!D) continue;
        const DC = D.contracts || D;
        if (!DC.wsXmrHub || !DC.wsXMR) continue;
        state.chains[key] = {
            cfg, D,
            client: createPublicClient({
                chain: { id: cfg.chainId, name: cfg.name, nativeCurrency: cfg.nativeCurrency, rpcUrls: { default: { http: cfg.rpcUrls } } },
                transport: fallback(cfg.rpcUrls.map(u => http(u)))
            })
        };
    }

    const keys = Object.keys(state.chains);
    const chainsEl = document.getElementById('stat-chains');
    if (chainsEl) chainsEl.textContent = String(keys.length);

    // Skeletons first so layout doesn't jump
    if (live) live.innerHTML = keys.map(renderChainCard).join('') + renderSoonCard();

    // XMR spot: CoinGecko first (independent of oracle freshness), hub as fallback
    try {
        const res = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=monero&vs_currencies=usd', { signal: AbortSignal.timeout(8000) });
        const j = await res.json();
        state.xmrUsd = j.monero?.usd || 0;
    } catch (e) {}
    const tl = document.getElementById('tl-xmr-price');

    // Per-chain reads + dex, all independent
    let totalSupply = 0, totalVaults = 0, tvlUSD = 0, debtUSD = 0;
    async function refreshDex() {
        await Promise.all(keys.map(async (key) => {
            const { cfg, D } = state.chains[key];
            const pool = (D.pool && D.pool.uniswapV3Pool) || D.pool;
            if (!cfg.dexscreenerSlug || !pool) return;
            try {
                const pair = await fetchDex(cfg.dexscreenerSlug, pool);
                state.chains[key].dex = pair;
                applyDexToCard(key, pair);
            } catch (e) { console.warn(`[Landing] ${key} dex:`, e); }
        }));
    }

    await Promise.all([
        refreshDex(),
        ...keys.map(async (key) => {
            const { client, D } = state.chains[key];
            const DC = D.contracts || D;
            try {
                const s = await readChainStats(key, client, DC.wsXmrHub, DC.wsXMR, parseAbi, formatUnits);
                state.chains[key].onchain = s;
                applyOnchainToCard(key, s);
                totalSupply += s.supply; totalVaults += s.vaults;
                tvlUSD += s.tvlUsd; debtUSD += s.debtUsd;
            } catch (e) { console.warn(`[Landing] ${key} onchain:`, e); }
        })
    ]);

    if (!state.xmrUsd) state.xmrUsd = keys.map(k => state.chains[k].onchain?.xmrUsd).find(v => v > 0) || 0;
    if (tl && state.xmrUsd) tl.textContent = `$${Math.round(state.xmrUsd)}`;

    // Aggregates
    const supplyEl = document.getElementById('stat-supply');
    if (supplyEl) supplyEl.textContent = totalSupply < 0.01 ? totalSupply.toFixed(8) : totalSupply.toFixed(3);
    const tvlEl = document.getElementById('stat-tvl');
    if (tvlEl) tvlEl.textContent = fmtUsd(tvlUSD);
    const vaultsEl = document.getElementById('stat-active-vaults');
    if (vaultsEl) vaultsEl.textContent = String(totalVaults);
    const crEl = document.getElementById('stat-collateral-ratio');
    if (crEl) {
        const cr = debtUSD > 0 ? (tvlUSD / debtUSD) * 100 : 0;
        crEl.textContent = debtUSD === 0 ? '—' : (cr > 9999 ? '>9,999%' : `${Math.round(cr)}%`);
    }

    // Re-apply dex so premiums pick up oracle prices that landed after dex did
    keys.forEach(k => { if (state.chains[k].dex) applyDexToCard(k, state.chains[k].dex); });

    setInterval(refreshDex, REFRESH_MS);
}

main().catch(err => console.warn('[Landing] init failed:', err));
