// Chain selection — shared by every page.
//
// There is no default chain: the user picks. We remember the pick in
// localStorage so returning visitors land back where they were. When no
// saved choice exists we auto-select only if exactly one chain is deployed;
// otherwise a modal forces an explicit choice.
//
// bootChain() MUST run before initializeClients()/readHub()/writeHub() —
// it resolves the active chain and populates CONTRACTS from the chain's
// deployment manifest.

import { CHAINS, setActiveChain, getActiveChain, getActiveChainKey, loadDeployment } from './config.js?v=3.33';
import { switchToActiveChain, getUserAddress } from './viemClient.js?v=3.33';

const STORAGE_KEY = 'wrapsynth-active-chain';

/** Keys of chains that have a deployment manifest served. */
export async function deployedChains() {
    const out = [];
    for (const key of Object.keys(CHAINS)) {
        if (await loadDeployment(key)) out.push(key);
    }
    return out;
}

/**
 * Resolve the active chain and return its key.
 * ?chain= param → saved → first-deployed (when only one exists) → modal picker.
 * Returns null when nothing is deployed at all.
 */
export async function bootChain() {
    const deployed = await deployedChains();
    if (deployed.length === 0) {
        console.error('[CHAIN] No deployment manifests found — nothing deployed?');
        return null;
    }

    // Deep link: ?chain=bnb overrides the saved choice
    const urlKey = new URLSearchParams(location.search).get('chain');
    if (urlKey && deployed.includes(urlKey)) {
        localStorage.setItem(STORAGE_KEY, urlKey);
        await setActiveChain(urlKey);
        return urlKey;
    }

    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && deployed.includes(saved)) {
        await setActiveChain(saved);
        return saved;
    }
    if (deployed.length === 1) {
        await setActiveChain(deployed[0]);
        return deployed[0];
    }
    const key = await showChainModal(deployed);
    await setActiveChain(key);
    return key;
}

/** Chain logo + collateral-token logo as overlapping round badges. */
function iconPair(c, size = 20) {
    const badge = (src, letter, off) => src
        ? `<img src="${src}" alt="" style="width:${size}px;height:${size}px;border-radius:50%;object-fit:cover;${off}background:#222" onerror="this.outerHTML='<span style=&quot;display:inline-flex;width:${size}px;height:${size}px;border-radius:50%;background:#444;color:#fff;align-items:center;justify-content:center;font-size:${size * .55}px;font-weight:700;${off}&quot;>${letter}</span>'">`
        : `<span style="display:inline-flex;width:${size}px;height:${size}px;border-radius:50%;background:#444;color:#fff;align-items:center;justify-content:center;font-size:${size * .55}px;font-weight:700;${off}">${letter}</span>`;
    return `<span style="display:inline-flex;align-items:center;flex:none">${badge(c.chainIcon, c.name[0], '')}${badge(c.collateral.icon, c.collateral.symbol[0], 'margin-left:-8px;border:2px solid var(--card,#14181f);')}</span>`;
}

/** Modal picker — resolves when the user clicks a chain.
 *  Cards explain each deployment: the wsXMR pair, what the collateral is,
 *  and which gas token the user needs to fund. Undeployed chains are shown
 *  but disabled. */
function showChainModal(deployed) {
    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.7);backdrop-filter:blur(4px);z-index:10000;display:flex;align-items:center;justify-content:center';
        const card = k => {
            const c = CHAINS[k];
            const live = deployed.includes(k);
            const gas = c.nativeCurrency.symbol;
            const coll = c.collateral;
            return `
                <button data-chain="${k}" ${live ? '' : 'disabled'} style="display:block;width:100%;margin:8px 0;padding:14px;border-radius:10px;border:1px solid var(--border,#2a2f3a);background:var(--bg2,#1a1f2a);color:inherit;${live ? 'cursor:pointer' : 'opacity:.45;cursor:not-allowed'};text-align:left">
                    <div style="display:flex;justify-content:space-between;align-items:center;gap:8px">
                        <span style="display:flex;align-items:center;gap:10px">${iconPair(c)}<span style="font-size:15px;font-weight:700">${c.name}</span></span>
                        <span style="font-size:12px;font-weight:600;color:var(--accent,#f7931a)">wsXMR ⇄ ${coll.symbol}</span>
                    </div>
                    <div style="color:var(--muted,#8a94a6);font-size:12px;margin-top:4px">${coll.whatItIs || coll.name}</div>
                    <div style="color:var(--muted,#8a94a6);font-size:11.5px;margin-top:4px">
                        Gas: ${gas} · Mint needs ${gas} + XMR${coll.note ? ` · ${coll.note}` : ''}
                    </div>
                    ${live ? '' : '<div style="color:var(--muted,#8a94a6);font-size:11px;margin-top:4px;font-style:italic">Not deployed yet</div>'}
                </button>`;
        };
        overlay.innerHTML = `
            <div style="background:var(--card,#14181f);border:1px solid var(--border,#2a2f3a);border-radius:16px;padding:32px;max-width:430px;width:92%;text-align:left">
                <div style="font-weight:700;font-size:18px;margin-bottom:6px;text-align:center">Choose a chain</div>
                <div style="color:var(--muted,#8a94a6);font-size:13px;margin-bottom:18px;text-align:center">Each chain runs an independent wsXMR deployment backed by a different collateral asset — pick the backing you want.</div>
                ${Object.keys(CHAINS).map(card).join('')}
            </div>`;
        overlay.addEventListener('click', async (e) => {
            const btn = e.target.closest('[data-chain]:not([disabled])');
            if (!btn) return;
            const key = btn.dataset.chain;
            localStorage.setItem(STORAGE_KEY, key);
            overlay.remove();
            resolve(key);
        });
        document.body.appendChild(overlay);
    });
}

/**
 * Bind a <select> element to chain state. Options show every registry chain;
 * undeployed ones are disabled. On change: setActiveChain → persist →
 * wallet chain switch (if connected) → 'wrapsynth:chainChanged' fires for
 * page modules to re-render.
 */
export async function initChainPicker(selectEl) {
    if (!selectEl) return;
    const deployed = await deployedChains();

    // A native <select> can't render images — build a custom dropdown and
    // hide the select (kept in DOM as a semantic fallback).
    selectEl.style.display = 'none';
    const wrap = document.createElement('div');
    wrap.className = 'pill chain-picker';
    wrap.style.cssText = 'position:relative;cursor:pointer;display:inline-flex;align-items:center';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.style.cssText = 'background:transparent;color:inherit;border:none;font:inherit;cursor:pointer;display:flex;align-items:center;gap:8px;padding:0';
    const menu = document.createElement('div');
    menu.style.cssText = 'display:none;position:absolute;top:calc(100% + 8px);right:0;min-width:220px;background:var(--card,#14181f);border:1px solid var(--border,#2a2f3a);border-radius:12px;padding:6px;z-index:9999;box-shadow:0 8px 24px rgba(0,0,0,.4)';
    wrap.append(btn, menu);
    selectEl.replaceWith(wrap);

    const render = () => {
        const active = CHAINS[getActiveChainKey()];
        btn.innerHTML = active
            ? `${iconPair(active, 18)}<span>${active.name}</span><span style="color:var(--muted,#8a94a6);font-size:11px">▾</span>`
            : 'Select chain';
        menu.innerHTML = Object.keys(CHAINS).map(k => {
            const c = CHAINS[k];
            const live = deployed.includes(k);
            const isActive = k === getActiveChainKey();
            return `<div data-chain="${k}" role="option" aria-disabled="${!live}" style="display:flex;align-items:center;gap:10px;padding:9px 12px;border-radius:8px;${live ? 'cursor:pointer' : 'opacity:.45;cursor:not-allowed'};${isActive ? 'background:var(--bg2,#1a1f2a);font-weight:600' : ''}">
                ${iconPair(c, 18)}
                <span style="flex:1">${c.name} · ${c.collateral.symbol}</span>
                ${live ? '' : '<span style="font-size:10px;color:var(--muted,#8a94a6)">soon</span>'}
            </div>`;
        }).join('');
    };
    render();
    window.addEventListener('wrapsynth:chainChanged', render);

    const close = () => { menu.style.display = 'none'; };
    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
    });
    document.addEventListener('click', close);
    menu.addEventListener('click', async (e) => {
        const row = e.target.closest('[data-chain]');
        if (!row || row.getAttribute('aria-disabled') === 'true') return;
        close();
        const key = row.dataset.chain;
        if (!key || key === getActiveChainKey()) return;
        try {
            localStorage.setItem(STORAGE_KEY, key);
            await setActiveChain(key);
            if (getUserAddress()) {
                try { await switchToActiveChain(); }
                catch (err) { console.warn('[CHAIN] wallet refused chain switch:', err.message); }
            }
        } catch (err) {
            console.error('[CHAIN] switch failed:', err.message);
            render();
        }
    });
}
