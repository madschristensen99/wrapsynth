// fundingGuide.js — per-chain "what do I need" panel.
//
// Each chain demands different assets depending on what the user is doing:
//   mint  → native gas token (covers gas + the vault's griefing deposit) + XMR
//   burn  → wsXMR + native gas
//   lp    → the chain's collateral token (QQQB / cbBTC / SPY) + native gas
//   swap  → nothing special — any DEX swap routes into the wsXMR/<collateral> pool
//
// renderFundingPanel(el, mode) renders a compact checklist into a container.
// When a wallet is connected it checks real balances and marks each item
// ✓ (have enough) / ✗ (need to acquire) with one-click acquire links.
// Containers opt in with a data-funding-mode attribute; refreshFundingPanels()
// re-renders all of them (call after connect / chain change / vault select).

import { getActiveChain, getActiveChainKey, CONTRACTS, ASSET } from './config.js?v=3.30';
import { getUserAddress, getPublicClient, getNativeBalance } from './viemClient.js?v=3.30';
import { formatUnits } from 'https://esm.sh/viem@2.7.0';

const ERC20_BALANCE_ABI = [{
    name: 'balanceOf', type: 'function', stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ name: '', type: 'uint256' }],
}];

// Conservative gas buffer for an initiateMint-style tx (native units).
// BNB/Base/Robinhood gas is cheap; 0.0005 covers it with margin.
const GAS_BUFFER = 500000000000000n; // 5e14 wei = 0.0005

function acquireLinks(list, wsxmrAddr) {
    return (list || []).map(l => {
        const url = l.url.replace('{wsxmr}', wsxmrAddr || '');
        return `<a href="${url}" target="_blank" rel="noopener" style="color:var(--accent,#f7931a);font-weight:600">${l.label} ↗</a>`;
    }).join(' · ');
}

async function erc20Balance(token, owner, client) {
    if (!token || !owner) return null;
    try {
        return await client.readContract({
            address: token, abi: ERC20_BALANCE_ABI, functionName: 'balanceOf', args: [owner]
        });
    } catch { return null; }
}

/**
 * Render the funding checklist.
 * @param {HTMLElement} el   container (keeps a data-funding-mode attr)
 * @param {string} mode      'mint' | 'burn' | 'lp' | 'swap'
 * @param {object} opts      { griefingDepositWei?: bigint } — actual vault value when known
 */
export async function renderFundingPanel(el, mode, opts = {}) {
    if (!el) return;
    const chain = getActiveChain();
    if (!chain || !chain.acquire) return;
    const acq = chain.acquire;
    const addr = getUserAddress();
    let client = null;
    try { client = addr ? getPublicClient() : null; } catch { /* clients not initialized yet */ }
    const gasSym = chain.nativeCurrency.symbol;
    const coll = chain.collateral;
    const wsxmrAddr = CONTRACTS.wsxmrToken;

    // ── fetch balances (only when connected) ──────────────────────────────
    let nativeBal = null, wsxmrBal = null, collBal = null;
    if (addr && client) {
        [nativeBal, wsxmrBal, collBal] = await Promise.all([
            getNativeBalance(addr).catch(() => null),
            erc20Balance(wsxmrAddr, addr, client),
            erc20Balance(coll.address, addr, client),
        ]);
    }

    const rows = [];
    const fmt = (v, d) => v === null ? null : parseFloat(formatUnits(v, d)).toPrecision(4);

    // Gas + griefing deposit — needed by every action
    const griefing = opts.griefingDepositWei ?? null;
    const gasNeeded = (griefing ?? 0n) + GAS_BUFFER;
    const gasNeededText = griefing !== null
        ? `~${formatUnits(gasNeeded, 18)} ${gasSym}`
        : `gas + griefing deposit`;
    rows.push({
        ok: nativeBal === null ? null : nativeBal >= gasNeeded,
        label: `${gasSym} for ${gasNeededText}`,
        balance: nativeBal === null ? null : `${fmt(nativeBal, 18)} ${gasSym}`,
        links: acq.gas,
    });

    if (mode === 'burn' || mode === 'swap') {
        rows.push({
            ok: wsxmrBal === null ? null : wsxmrBal > 0n,
            label: 'wsXMR',
            balance: wsxmrBal === null ? null : `${fmt(wsxmrBal, 8)} wsXMR`,
            links: acq.wsxmr,
            // Minting is the primary path — the pool is only useful once seeded.
            emptyNote: 'Mint it with XMR on the Mint tab, or buy on the pool:',
        });
    }
    if (mode === 'lp') {
        rows.push({
            ok: collBal === null ? null : collBal > 0n,
            label: `${coll.symbol} (vault collateral)`,
            balance: collBal === null ? null : `${fmt(collBal, coll.decimals)} ${coll.symbol}`,
            links: acq.collateral,
        });
    }
    if (mode === 'mint') {
        rows.push({
            ok: null, // can't check XMR balance from here
            label: 'XMR in your Monero wallet',
            balance: null,
            links: [],
            sub: 'You send XMR to the LP\'s deposit address after initiating.',
        });
    }

    const dot = ok => ok === null ? '·' : ok ? '✓' : '✗';
    const cls = ok => ok === null ? '' : ok ? 'color:var(--success,#3fb950)' : 'color:var(--error,#f85149)';

    el.innerHTML = `
        <div style="border:1px solid var(--border,#2a2f3a);border-radius:10px;padding:12px 14px;font-size:12.5px;background:var(--bg2,#141821)">
            <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:8px">
                <span style="font-weight:700">Funded for ${chain.name}?</span>
                ${addr ? '' : '<span style="color:var(--muted,#8a94a6)">connect wallet to check balances</span>'}
            </div>
            ${rows.map(r => `
                <div style="display:flex;justify-content:space-between;gap:8px;padding:3px 0;align-items:baseline">
                    <span><span style="${cls(r.ok)};font-weight:700;margin-right:6px">${dot(r.ok)}</span>${r.label}</span>
                    <span style="text-align:right;white-space:nowrap">
                        ${r.balance ? `<span style="color:var(--muted,#8a94a6);margin-right:8px">${r.balance}</span>` : ''}
                        ${(r.ok === false || r.ok === null) ? acquireLinks(r.links, wsxmrAddr) : ''}
                    </span>
                </div>
                ${r.sub ? `<div style="color:var(--muted,#8a94a6);font-size:11.5px;padding-left:18px">${r.sub}</div>` : ''}
                ${r.emptyNote && r.ok === false ? `<div style="color:var(--muted,#8a94a6);font-size:11.5px;padding-left:18px">${r.emptyNote}</div>` : ''}
            `).join('')}
            <div style="margin-top:8px;padding-top:8px;border-top:1px solid var(--border,#2a2f3a);color:var(--muted,#8a94a6);font-size:11.5px">
                Pair: <b style="color:var(--text)">wsXMR ⇄ ${coll.symbol}</b> — ${coll.whatItIs || coll.name}
                ${coll.note ? `<br>${coll.note}` : ''}
                ${acq.gasHint ? `<br>${acq.gasHint}` : ''}
            </div>
        </div>`;
}

/** Re-render every mounted funding panel (call after connect / vault pick). */
export function refreshFundingPanels(extraOpts = {}) {
    document.querySelectorAll('[data-funding-mode]').forEach(el => {
        renderFundingPanel(el, el.dataset.fundingMode, extraOpts);
    });
}
