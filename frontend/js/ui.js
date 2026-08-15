// UI Controller
// Manages all DOM interactions and updates

import { DECIMALS } from './config.js';
import { getIconSVG } from './icons.js';
import { launchMintCelebration, launchBurnAnimation } from './animations.js';

/**
 * UI Element References
 */
const elements = {
    // Wallet
    connectWallet: null,
    connectedInfo: null,
    userAddress: null,
    userBalance: null,
    
    // Banners
    contractsBanner: null,
    resumeBanner: null,
    resumeSwapList: null,
    resumeBannerTitle: null,
    
    // Main interface
    mainInterface: null,
    
    // Tabs
    tabMint: null,
    tabBurn: null,
    tabCoLP: null,
    tabLp: null,
    
    // Panels
    mintPanel: null,
    burnPanel: null,
    coLPPanel: null,
    lpPanel: null,
    
    // Mint panel elements
    mintPanelContent: null,
    mintAmount: null,
    mintVaultSelect: null,
    mintVaultInfo: null,
    startMint: null,
    mintProgress: null,
    mintDepositInfo: null,
    mintQrCode: null,
    mintXmrAddress: null,
    mintExactAmount: null,
    mintActions: null,
    cancelMint: null,
    
    // Burn panel
    burnPanel: null,
    burnAmount: null,
    burnXmrDestination: null,
    burnVaultSelect: null,
    burnVaultInfo: null,
    burnUserBalance: null,
    startBurn: null,
    burnProgress: null,
    cancelBurn: null,
    
    // Modal
    modalOverlay: null,
    modalTitle: null,
    modalBody: null,
    modalCloseBtn: null,
    modalCancelBtn: null,
    modalConfirmBtn: null,
    modalXBtn: null,
    
    // Withdraw returns
    withdrawReturnsBtn: null,
    
    // Previous mint banner
    previousMintBanner: null
};

/**
 * Initialize UI elements
 */
export function initUI() {
    // Wallet
    elements.connectWallet = document.getElementById('connect-wallet');
    elements.connectedInfo = document.getElementById('connected-info');
    elements.userAddress = document.getElementById('user-address');
    elements.userBalance = document.getElementById('user-balance');
    
    // Banners
    elements.contractsBanner = document.getElementById('contracts-banner');
    elements.resumeBanner = document.getElementById('resume-banner');
    elements.resumeSwapList = document.getElementById('resume-swap-list');
    elements.resumeBannerTitle = document.getElementById('resume-banner-title');
    
    // Main interface
    elements.mainInterface = document.getElementById('main-interface');
    
    // Tabs
    elements.tabMint = document.getElementById('tab-mint');
    elements.tabBurn = document.getElementById('tab-burn');
    elements.tabCoLP = document.getElementById('tab-co-lp');
    elements.tabLp = document.getElementById('tab-lp');
    
    // Panels
    elements.mintPanel = document.getElementById('mint-panel');
    elements.burnPanel = document.getElementById('burn-panel');
    elements.coLPPanel = document.getElementById('co-lp-panel');
    elements.lpPanel = document.getElementById('lp-panel');
    
    // Mint panel elements
    elements.mintPanelContent = document.getElementById('mint-panel');
    elements.mintAmount = document.getElementById('mint-amount');
    elements.mintVaultSelect = document.getElementById('mint-vault-select');
    elements.mintVaultInfo = document.getElementById('mint-vault-info');
    elements.startMint = document.getElementById('start-mint');
    elements.mintProgress = document.getElementById('mint-progress');
    elements.mintDepositInfo = document.getElementById('mint-deposit-info');
    elements.mintQrCode = document.getElementById('mint-qr-code');
    elements.mintXmrAddress = document.getElementById('mint-xmr-address');
    elements.mintExactAmount = document.getElementById('mint-exact-amount');
    elements.confirmSentXmr = document.getElementById('confirm-sent-xmr');
    elements.waitingLpVerification = document.getElementById('waiting-lp-verification');
    elements.mintActions = document.getElementById('mint-actions');
    elements.cancelMint = document.getElementById('cancel-mint');
    
    // Burn panel
    elements.burnPanel = document.getElementById('burn-panel');
    elements.burnAmount = document.getElementById('burn-amount');
    elements.burnXmrDestination = document.getElementById('burn-xmr-destination');
    elements.burnVaultSelect = document.getElementById('burn-vault-select');
    elements.burnVaultInfo = document.getElementById('burn-vault-info');
    elements.burnUserBalance = document.getElementById('burn-user-balance');
    console.log('[initUI] burnUserBalance element:', elements.burnUserBalance ? 'found' : 'NOT FOUND');
    elements.startBurn = document.getElementById('start-burn');
    elements.burnProgress = document.getElementById('burn-progress');
    elements.cancelBurn = document.getElementById('cancel-burn');
    
    // Modal
    elements.modalOverlay = document.getElementById('modal-overlay');
    elements.modalTitle = document.getElementById('modal-title');
    elements.modalBody = document.getElementById('modal-body');
    elements.modalCloseBtn = document.getElementById('modal-close-btn');
    elements.modalCancelBtn = document.getElementById('modal-cancel-btn');
    elements.modalConfirmBtn = document.getElementById('modal-confirm-btn');
    elements.modalXBtn = document.getElementById('modal-x-btn');
    
    // Withdraw returns
    elements.withdrawReturnsBtn = document.getElementById('withdraw-returns-btn');
    
    // Previous mint banner
    elements.previousMintBanner = document.getElementById('previous-mint-banner');
    
    // Setup modal close handlers
    elements.modalXBtn.addEventListener('click', hideModal);
    elements.modalCloseBtn.addEventListener('click', hideModal);
    elements.modalOverlay.addEventListener('click', (e) => {
        if (e.target === elements.modalOverlay) {
            hideModal();
        }
    });
}

/**
 * Show wallet connected state
 */
export function showWalletConnected(address, balance) {
    elements.connectWallet.classList.add('hidden');
    elements.connectedInfo.classList.remove('hidden');
    elements.userAddress.textContent = formatAddress(address);
    updateBalance(balance);
    // Enable action buttons
    elements.startMint.disabled = false;
    elements.startBurn.disabled = false;
    elements.mintAmount.disabled = false;
    elements.burnAmount.disabled = false;
}

/**
 * Show/hide withdraw returns button based on pending amount
 */
export function setWithdrawReturnsVisible(visible) {
    if (elements.withdrawReturnsBtn) {
        if (visible) {
            elements.withdrawReturnsBtn.classList.remove('hidden');
        } else {
            elements.withdrawReturnsBtn.classList.add('hidden');
        }
    }
}

/**
 * Show wallet disconnected state
 */
export function showWalletDisconnected() {
    elements.connectWallet.classList.remove('hidden');
    elements.connectedInfo.classList.add('hidden');
    // Disable action buttons since wallet is required
    elements.startMint.disabled = true;
    elements.startBurn.disabled = true;
}

/**
 * Update user balance display
 */
export function updateBalance(balance) {
    const balText = formatBalance(balance, DECIMALS.wsXMR);
    elements.userBalance.textContent = `${balText} wsXMR`;
    if (elements.burnUserBalance) {
        elements.burnUserBalance.textContent = balText;
    }
    // Fallback: query DOM directly in case the cached element ref is stale
    const burnBal = document.getElementById('burn-user-balance');
    if (burnBal) {
        burnBal.textContent = balText;
    }
    console.log('[updateBalance] set to:', balText);
}

/**
 * Show resume banner with list of active swaps
 * @param {Array} swaps - Array of active swap states
 * @param {Function} onResume - Callback when user clicks resume on a swap (receives swap object)
 * @param {Function} onResolve - Callback when user clicks resolve on an unresumable swap
 */
export function showResumeBanner(swaps, onResume, onResolve) {
    if (!swaps || swaps.length === 0) {
        hideResumeBanner();
        return;
    }

    // Update title
    elements.resumeBannerTitle.textContent = swaps.length === 1
        ? 'Active operation detected!'
        : `${swaps.length} active operations detected!`;

    // Build list
    elements.resumeSwapList.innerHTML = '';
    for (const swap of swaps) {
        const container = document.createElement('div');
        container.className = 'resume-swap-item';
        container.dataset.requestId = swap.requestId || '';

        const row = document.createElement('div');
        row.className = 'resume-swap-row';

        const typeLabel = swap.type === 'mint' ? 'Mint' : 'Burn';
        const amount = swap.type === 'mint'
            ? (swap.xmrAmount ? `${swap.xmrAmount.toFixed ? swap.xmrAmount.toFixed(6) : swap.xmrAmount} XMR` : 'Mint')
            : (swap.wsxmrAmount ? `${(Number(swap.wsxmrAmount) / 1e8).toFixed(4)} wsXMR` : 'Burn');
        const stateLabel = formatSwapState(swap.state);
        const vaultShort = swap.lpVault ? `${swap.lpVault.slice(0, 6)}...${swap.lpVault.slice(-4)}` : '';

        row.innerHTML = `
            <span>
                <strong>${typeLabel}</strong> <span class="swap-amount">${amount}</span>
                <span class="swap-state">(${stateLabel})</span>
                ${vaultShort ? `<span class="swap-vault"> ${vaultShort}</span>` : ''}
            </span>
        `;

        // Show deposit address for mints that are waiting for XMR or LP verification
        const showDepositAddr = swap.type === 'mint'
            && (swap.state === 'deposit' || swap.state === 'lp-verifying')
            && swap.depositAddress;

        // Both burns and mints need the stored publicSpendKey to resume
        // Exclude zero-value keys (0x000...0) that come from uninitialized on-chain fields
        const hasValidKey = swap.publicSpendKey != null
            && swap.publicSpendKey !== ''
            && swap.publicSpendKey !== '0x0000000000000000000000000000000000000000000000000000000000000000';
        const canResume = hasValidKey;
        // A mint is only truly claimable if the LP has verified it AND we still have the secret.
        // Without the secret we cannot generate the view key to verify the LP's proof.
        const isClaimableMint = swap.type === 'mint' && (swap.state === 'lp-ready' || swap.state === 'finalize') && canResume;
        const showResume = canResume || isClaimableMint;

        const btn = document.createElement('button');
        btn.className = 'btn-small';
        if (isClaimableMint) {
            btn.textContent = 'Claim wsXMR';
            btn.classList.add('success');
        } else if (showResume) {
            btn.textContent = 'Resume';
        } else {
            btn.textContent = 'Resolve';
            btn.classList.add('secondary');
        }
        btn.addEventListener('click', () => {
            if (showResume) {
                if (onResume) onResume(swap);
            } else {
                if (onResolve) onResolve(swap);
            }
        });
        row.appendChild(btn);

        container.appendChild(row);

        // Show deposit address for mints waiting for XMR or LP verification
        if (showDepositAddr) {
            const addrShort = swap.depositAddress.slice(0, 12) + '...' + swap.depositAddress.slice(-8);
            const depositRow = document.createElement('div');
            depositRow.className = 'resume-swap-deposit';
            depositRow.style.cssText = 'font-size:0.8rem;color:var(--text-muted);margin-top:4px;margin-left:8px;word-break:break-all;';
            depositRow.innerHTML = `Send XMR to: <span style="font-family:monospace;color:var(--text);">${addrShort}</span> <button class="btn-small" style="padding:2px 6px;font-size:0.7rem;margin-left:4px;" onclick="navigator.clipboard.writeText('${swap.depositAddress}');this.textContent='Copied!';setTimeout(()=>this.textContent='Copy',2000)">Copy</button>`;
            container.appendChild(depositRow);
        }

        elements.resumeSwapList.appendChild(container);
    }

    elements.resumeBanner.classList.remove('hidden');
}

function formatSwapState(state) {
    const labels = {
        'init': 'Initializing',
        'evm-init': 'Griefing deposit',
        'initiated': 'Initiated',
        'awaiting-lp-key': 'Awaiting LP',
        'deposit': 'Deposit XMR',
        'lp-ready': 'LP Ready',
        'lp-verifying': 'LP Verifying',
        'lp-confirm': 'LP Confirming',
        'finalize': 'Finalizing',
        'evm-request': 'Requesting',
        'lp-propose': 'LP Proposing',
        'confirm-lock': 'Claiming XMR',
        'lp-finalize': 'Finalizing',
        'committed': 'Committed',
        'completed': 'Complete',
        'expired': 'Expired'
    };
    return labels[state] || state;
}

/**
 * Show inline error on a resume banner swap item.
 * @param {string} requestId - The swap's requestId
 * @param {string} message - Error message to display
 */
export function showResumeError(requestId, message) {
    if (!elements.resumeSwapList) return;
    const item = elements.resumeSwapList.querySelector(
        `.resume-swap-item[data-request-id="${requestId}"]`
    );
    if (!item) return;

    // Remove any existing error
    const existing = item.querySelector('.resume-error');
    if (existing) existing.remove();

    const errDiv = document.createElement('div');
    errDiv.className = 'resume-error';
    errDiv.textContent = message;
    item.appendChild(errDiv);
}

/**
 * Show inline success on a resume banner swap item.
 * @param {string} requestId - The swap's requestId
 * @param {string} message - Success message to display
 */
export function showResumeSuccess(requestId, message) {
    if (!elements.resumeSwapList) return;
    const item = elements.resumeSwapList.querySelector(
        `.resume-swap-item[data-request-id="${requestId}"]`
    );
    if (!item) return;

    // Remove any existing success/error
    const existing = item.querySelector('.resume-success, .resume-error');
    if (existing) existing.remove();

    const succDiv = document.createElement('div');
    succDiv.className = 'resume-success';
    succDiv.textContent = message;
    item.appendChild(succDiv);
}

/**
 * Hide resume banner
 */
export function hideResumeBanner() {
    elements.resumeBanner.classList.add('hidden');
    elements.resumeSwapList.innerHTML = '';
}

/**
 * Show contracts not deployed banner
 */
export function showContractsBanner() {
    elements.contractsBanner.classList.remove('hidden');
}

/**
 * Hide contracts banner
 */
export function hideContractsBanner() {
    elements.contractsBanner.classList.add('hidden');
}

const ACTIVE_TAB_KEY = 'wrapsynth-active-tab';

export function saveActiveTab(tab) {
    try {
        localStorage.setItem(ACTIVE_TAB_KEY, tab);
    } catch (e) {
        // ignore (private browsing mode)
    }
}

/**
 * Switch to mint tab
 */
export function showMintTab() {
    console.log('[UI] Switching to Mint tab');
    elements.tabMint.classList.add('active');
    elements.tabBurn.classList.remove('active');
    elements.tabCoLP.classList.remove('active');
    elements.tabLp.classList.remove('active');
    elements.mintPanel.classList.remove('hidden');
    elements.burnPanel.classList.add('hidden');
    elements.coLPPanel.classList.add('hidden');
    elements.lpPanel.classList.add('hidden');
    saveActiveTab('mint');
}

/**
 * Switch to burn tab
 */
export async function showBurnTab() {
    elements.tabBurn.classList.add('active');
    elements.tabMint.classList.remove('active');
    elements.tabCoLP.classList.remove('active');
    elements.tabLp.classList.remove('active');
    elements.burnPanel.classList.remove('hidden');
    elements.mintPanel.classList.add('hidden');
    elements.coLPPanel.classList.add('hidden');
    elements.lpPanel.classList.add('hidden');
    saveActiveTab('burn');

    // Update balance when showing burn tab
    const { getUserAddress, getWsXmrBalance } = await import('./viemClient.js');
    const address = getUserAddress();
    if (address) {
        try {
            const balance = await getWsXmrBalance(address);
            updateBalance(balance);
        } catch (error) {
            console.warn('Could not fetch balance:', error);
        }
    }
}

/**
 * Compute vault summary stats for display in dropdowns.
 */
function vaultSummary(v) {
    const collateral = v.collateralAmount || 0;
    const debt = v.actualDebt ? Number(v.actualDebt) / 1e8 : 0;
    const xmrPrice = v.xmrPrice || 200;
    const collPrice = v.collPrice || 1.0;
    const collateralUSD = collateral * collPrice;
    const debtUSD = debt * xmrPrice;
    const cr = debtUSD > 0 ? Math.round((collateralUSD / debtUSD) * 100) : 200;
    const crColor = cr >= 200 ? 'var(--teal)' : cr >= 150 ? 'var(--amber)' : 'var(--red)';
    const dotColor = cr >= 200 ? '#2fe6c4' : cr >= 150 ? '#facc15' : '#ff4444';
    const cap = v.maxMintCapacityXmr || 0;
    const capPct = collateral > 0 ? Math.min(100, (cap * xmrPrice / (collateralUSD || 1)) * 100) : 0;
    const feePct = (v.mintFeeBps || 0) / 100;
    return { cr, crColor, dotColor, cap, capPct, feePct, collateral, debt };
}

/**
 * Render a single vault picker dropdown (mint or burn).
 */
export function renderVaultPicker(prefix, vaults) {
    const listEl = document.getElementById(`${prefix}-vp-list`);
    const selectedEl = document.getElementById(`${prefix}-vp-selected`);
    const hiddenSelect = document.getElementById(`${prefix}-vault-select`);
    if (!listEl || !selectedEl || !hiddenSelect) return;

    // Populate hidden select for .value compatibility
    hiddenSelect.innerHTML = vaults.map(v =>
        `<option value="${v.address}">${v.name || formatAddress(v.address)}</option>`
    ).join('');

    if (vaults.length === 0) {
        listEl.innerHTML = '<div class="vp-option" style="cursor:default;justify-content:center">No vaults available</div>';
        return;
    }

    // Render option rows
    listEl.innerHTML = vaults.map((v, i) => {
        const s = vaultSummary(v);
        const shortAddr = `${v.address.slice(0, 6)}...${v.address.slice(-4)}`;
        const capDisplay = v.capacityAvailable === false && !v.capacityEstimated ? 'N/A' : (v.capacityEstimated ? '~' : '') + (s.cap < 0.001 ? s.cap.toExponential(1) : s.cap < 1 ? s.cap.toFixed(3) : s.cap.toFixed(1));
        const capNearZero = s.cap > 0 && s.cap < 0.001;
        const capColor = capNearZero ? '#facc15' : s.dotColor;
        const lockIcon = v.lockedCollateral && Number(v.lockedCollateral) > 0n ? ' 🔒' : '';
        return `<div class="vp-option${i === 0 ? ' selected' : ''}" data-address="${v.address}">
            <span class="vp-o-dot" style="background:${capNearZero ? '#facc15' : s.dotColor};box-shadow:0 0 6px ${capNearZero ? '#facc1560' : s.dotColor + '60'}"></span>
            <span class="vp-o-addr">${shortAddr}${lockIcon}</span>
            <span class="vp-o-cr" style="color:${s.crColor}">${s.cr > 9999 ? '>9k' : s.cr + '%'} CR</span>
            <span class="vp-o-fee">${s.feePct.toFixed(1)}%</span>
            <span class="vp-o-cap">
                <span class="vp-o-cap-bar"><span class="vp-o-cap-fill" style="width:${s.capPct.toFixed(0)}%;background:${capColor}"></span></span>
                <span class="vp-o-cap-val" style="color:${capNearZero ? 'var(--amber)' : ''}">${capDisplay}</span>
            </span>
        </div>`;
    }).join('');

    // Set initial selected display (first vault)
    updateVaultPickerSelected(prefix, vaults[0]);

    // Wire up option clicks
    listEl.querySelectorAll('.vp-option').forEach(opt => {
        opt.addEventListener('click', (e) => {
            e.stopPropagation();
            const addr = opt.dataset.address;
            const vault = vaults.find(v => v.address === addr);
            if (!vault) return;

            // Update hidden select value
            hiddenSelect.value = addr;

            // Update selected display
            updateVaultPickerSelected(prefix, vault);

            // Mark selected option
            listEl.querySelectorAll('.vp-option').forEach(o => o.classList.remove('selected'));
            opt.classList.add('selected');

            // Close dropdown
            document.getElementById(`${prefix}-vault-picker`).classList.remove('open');

            // Dispatch change event so handleVaultSelect fires
            hiddenSelect.dispatchEvent(new Event('change', { bubbles: true }));
        });
    });
}

/**
 * Update the collapsed selected display for a vault picker.
 */
function updateVaultPickerSelected(prefix, vault) {
    const selectedEl = document.getElementById(`${prefix}-vp-selected`);
    if (!selectedEl) return;

    const s = vaultSummary(vault);
    const shortAddr = `${vault.address.slice(0, 6)}...${vault.address.slice(-4)}`;

    selectedEl.querySelector('.vp-dot').style.background = s.dotColor;
    selectedEl.querySelector('.vp-dot').style.boxShadow = `0 0 6px ${s.dotColor}60`;
    selectedEl.querySelector('.vp-addr').textContent = shortAddr;
    const crEl = selectedEl.querySelector('.vp-cr');
    crEl.textContent = `${s.cr > 9999 ? '>9,999%' : s.cr + '%'} CR`;
    crEl.style.color = s.crColor;
}

/**
 * Wire up open/close handlers for vault pickers.
 */
export function initVaultPickers() {
    ['mint', 'burn', 'colp'].forEach(prefix => {
        const picker = document.getElementById(`${prefix}-vault-picker`);
        const selected = document.getElementById(`${prefix}-vp-selected`);
        if (!picker || !selected) return;

        // Toggle open on click
        selected.addEventListener('click', (e) => {
            if (picker.classList.contains('disabled')) return;
            // Close all other pickers
            document.querySelectorAll('.vault-picker.open').forEach(p => {
                if (p !== picker) p.classList.remove('open');
            });
            picker.classList.toggle('open');
        });
    });

    // Click outside to close all pickers
    document.addEventListener('click', (e) => {
        if (!e.target.closest('.vault-picker')) {
            document.querySelectorAll('.vault-picker.open').forEach(p => p.classList.remove('open'));
        }
    });
}

/**
 * Set vault picker disabled state.
 */
export function setVaultPickerDisabled(prefix, disabled) {
    const picker = document.getElementById(`${prefix}-vault-picker`);
    if (!picker) return;
    if (disabled) {
        picker.classList.add('disabled');
        picker.classList.remove('open');
    } else {
        picker.classList.remove('disabled');
    }
}

/**
 * Populate vault select dropdown + custom vault pickers
 */
export function populateVaults(vaults) {
    const mintOptions = vaults.map(v => 
        `<option value="${v.address}">${v.name || formatAddress(v.address)}</option>`
    ).join('');
    
    const burnOptions = mintOptions;
    
    elements.mintVaultSelect.innerHTML = mintOptions;
    elements.burnVaultSelect.innerHTML = burnOptions;
    
    // Render custom vault pickers
    renderVaultPicker('mint', vaults);
    renderVaultPicker('burn', vaults);
    renderVaultPicker('colp', vaults);
    
    // Also populate Co-LP vault select
    const coLpVaultSelect = document.getElementById('colp-vault-select');
    if (coLpVaultSelect) {
        coLpVaultSelect.innerHTML = mintOptions;
    }
    
    // Also populate the Active LP Vaults display with circular progress rings
    const vaultsList = document.getElementById('vaults-list');
    if (vaultsList) {
        if (vaults.length === 0) {
            vaultsList.innerHTML = '<div style="text-align:center;padding:40px;color:var(--muted)">No active LP vaults found</div>';
        } else {
            // Circular ring chart helper
            const R = 44, CIRC = 2 * Math.PI * R;
            const crColor = (cr) => cr >= 150 ? 'var(--green)' : cr >= 120 ? 'var(--amber)' : 'var(--red)';
            const crLabel = (cr) => cr >= 150 ? 'healthy' : cr >= 120 ? 'watch' : 'liquidatable';
            const frac = (cr) => Math.max(0, Math.min(1, (cr - 100) / 150));
            const tick = (cr) => { const a = frac(cr) * 2 * Math.PI; return { x: (52 + R * Math.cos(a)).toFixed(1), y: (52 + R * Math.sin(a)).toFixed(1) }; };
            const liq = tick(120);
            
            const vaultsHtml = vaults.map(v => {
                const shortAddr = `${v.address.slice(0, 6)}...${v.address.slice(-4)}`;
                // Use pre-converted collateralAmount if available
                const collateral = v.collateralAmount || (v.collateral ? Number(v.collateral) / 1e18 : 0);
                // Use actual debt if available, otherwise fall back to normalized debt
                const debt = v.actualDebt ? Number(v.actualDebt) / 1e8 : (v.debt ? Number(v.debt) / 1e8 : 0);
                
                // Calculate ratio in USD terms (sDAI ≈ $1, wsXMR needs XMR price)
                // Use stored xmrPrice and collPrice from vault data if available
                const xmrPrice = v.xmrPrice || 200; // fallback
                const collPrice = v.collPrice || 1.0; // sDAI ≈ $1
                const collateralUSD = collateral * collPrice;
                const debtUSD = debt * xmrPrice;
                const cr = debtUSD > 0 ? Math.round((collateralUSD / debtUSD) * 100) : 200;
                const crDisplay = cr > 9999 ? '>9,999%' : `${cr}%`;
                
                // Calculate collateral breakdown percentages
                const usedColl = v.usedCollateral || 0;
                const pendingColl = v.pendingCollateral || 0;
                const bufferColl = v.bufferCollateral || 0;
                const coLpColl = v.deployedSDAIShares ? Number(v.deployedSDAIShares) / 1e18 : 0;
                const lockedColl = v.lockedCollateral ? Number(v.lockedCollateral) / 1e18 : 0;
                const totalColl = collateral;
                const freeColl = v.capacityAvailable === false && !v.capacityEstimated ? 0 : (v.freeCollateral || 0);
                
                const usedPct = totalColl > 0 ? (usedColl / totalColl) * 100 : 0;
                const pendingPct = totalColl > 0 ? (pendingColl / totalColl) * 100 : 0;
                const bufferPct = totalColl > 0 ? (bufferColl / totalColl) * 100 : 0;
                const coLpPct = totalColl > 0 ? (coLpColl / totalColl) * 100 : 0;
                const lockedPct = totalColl > 0 ? (lockedColl / totalColl) * 100 : 0;
                const freePct = totalColl > 0 ? (freeColl / totalColl) * 100 : 0;
                
                const pieChart = makePieChart(usedPct, pendingPct, bufferPct, coLpPct, freePct);
                
                const crColor = cr >= 200 ? 'var(--teal)' : cr >= 150 ? 'var(--amber)' : 'var(--red)';
                
                return `<div class="vc" onclick="window.location.href='lp-vault.html?address=${v.address}'">
                    <div class="vid">${shortAddr}</div>
                    <div class="ring" style="display:flex;justify-content:center;margin:8px 0">
                      ${pieChart}
                    </div>
                    <div style="text-align:center;margin-bottom:16px">
                      <div style="font-size:28px;font-weight:700;margin-bottom:4px;font-family:'JetBrains Mono';color:${crColor};text-shadow:0 0 20px ${crColor}40">${crDisplay}</div>
                      <div style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.1em">collateral ratio</div>
                    </div>
                    <div class="vrow" style="border-top:1px solid var(--line-2);padding-top:12px">
                      <span class="l"><span style="opacity:.6">collateral</span><b style="color:var(--fg)">${collateral.toFixed(4)} sDAI</b></span>
                      <span class="l"><span style="opacity:.6">debt</span><b style="color:var(--fg)">${debt.toFixed(4)} wsXMR</b></span>
                    </div>
                    <div class="vrow" style="font-size:12px;gap:10px;margin-top:14px;display:grid;grid-template-columns:1fr 1fr;row-gap:10px">
                      <span style="display:flex;align-items:center;gap:7px"><span style="color:#ff4444;font-size:14px;text-shadow:0 0 6px #ff444460">●</span> reserved <b style="margin-left:auto;color:var(--fg)">${usedColl.toFixed(2)}</b></span>
                      <span style="display:flex;align-items:center;gap:7px"><span style="color:#8b5cf6;font-size:14px;text-shadow:0 0 6px #8b5cf660">●</span> pending <b style="margin-left:auto;color:var(--fg)">${pendingColl.toFixed(2)}</b></span>
                      <span style="display:flex;align-items:center;gap:7px"><span style="color:#facc15;font-size:14px;text-shadow:0 0 6px #facc1560">●</span> safety <b style="margin-left:auto;color:var(--fg)">${bufferColl.toFixed(2)}</b></span>
                      <span style="display:flex;align-items:center;gap:7px"><span style="color:#3b82f6;font-size:14px;text-shadow:0 0 8px #3b82f680">●</span> co-lp <b style="margin-left:auto;color:var(--fg)">${coLpColl.toFixed(2)}</b></span>
                      <span style="display:flex;align-items:center;gap:7px"><span style="color:#f97316;font-size:14px;text-shadow:0 0 6px #f9731660">●</span> burn lock <b style="margin-left:auto;color:var(--fg)">${lockedColl.toFixed(2)}</b></span>
                      <span style="display:flex;align-items:center;gap:7px;grid-column:1/-1"><span style="color:#2fe6c4;font-size:14px;text-shadow:0 0 6px #2fe6c460">●</span> free <b style="margin-left:auto;color:var(--fg)">${v.capacityAvailable === false && !v.capacityEstimated ? '<span style="color:var(--amber)">unavailable</span>' : (v.capacityEstimated ? '~' : '') + freeColl.toFixed(2)}</b></span>
                    </div>
                  </div>`;
            }).join('');
            vaultsList.innerHTML = vaultsHtml;
        }
    }
}

/**
 * Show vault info
 */
export function showVaultInfo(vaultData, isMint = true) {
    const infoElement = isMint ? elements.mintVaultInfo : elements.burnVaultInfo;
    
    const html = `
        <p><strong>Total XMR Locked:</strong> ${formatBalance(vaultData.totalXmrLocked, DECIMALS.wsXMR)} XMR</p>
        <p><strong>Collateral:</strong> ${formatBalance(vaultData.totalCollateral, DECIMALS.ETH)} ${vaultData.collateralToken === '0x0000000000000000000000000000000000000000' ? 'xDAI' : 'Token'}</p>
        <p><strong>Collateralization:</strong> ${vaultData.collateralizationRatio / 100}%</p>
        <p><strong>Griefing Deposit:</strong> ${formatBalance(vaultData.mintGriefingDeposit, DECIMALS.ETH)} xDAI</p>
        <p><strong>Status:</strong> ${vaultData.isActive ? '✅ Active' : '❌ Inactive'}</p>
        <p class="vault-info-link"><a href="https://gnosisscan.io/address/${vaultData.lpVault || ''}" target="_blank" rel="noopener">${getIconSVG('externalLink')}<span>View on GnosisScan</span></a></p>
    `;
    
    infoElement.innerHTML = html;
    infoElement.classList.remove('hidden');
}

/**
 * Render the expandable LP detail card below the vault dropdown.
 * Uses data from cachedVaults (already fetched by loadVaults).
 */
export function renderLPDetailCard(isMint, vault) {
    const prefix = isMint ? 'mint' : 'burn';
    const card = document.getElementById(`${prefix}-lp-detail`);
    if (!card || !vault) {
        if (card) card.classList.add('hidden');
        return;
    }

    const collateral = vault.collateralAmount || 0;
    const debt = vault.actualDebt ? Number(vault.actualDebt) / 1e8 : 0;
    const xmrPrice = vault.xmrPrice || 200;
    const collPrice = vault.collPrice || 1.0;
    const collateralUSD = collateral * collPrice;
    const debtUSD = debt * xmrPrice;
    const cr = debtUSD > 0 ? Math.round((collateralUSD / debtUSD) * 100) : 200;
    const crDisplay = cr > 9999 ? '>9,999%' : `${cr}%`;
    const crColor = cr >= 200 ? 'var(--teal)' : cr >= 150 ? 'var(--amber)' : 'var(--red)';

    // Collateral breakdown
    const usedColl = vault.usedCollateral || 0;
    const pendingColl = vault.pendingCollateral || 0;
    const bufferColl = vault.bufferCollateral || 0;
    const coLpColl = vault.deployedSDAIShares ? Number(vault.deployedSDAIShares) / 1e18 : 0;
    const lockedColl = vault.lockedCollateral ? Number(vault.lockedCollateral) / 1e18 : 0;
    const totalColl = collateral;
    const freeColl = vault.capacityAvailable === false && !vault.capacityEstimated ? 0 : (vault.freeCollateral || 0);

    const usedPct = totalColl > 0 ? (usedColl / totalColl) * 100 : 0;
    const pendingPct = totalColl > 0 ? (pendingColl / totalColl) * 100 : 0;
    const bufferPct = totalColl > 0 ? (bufferColl / totalColl) * 100 : 0;
    const coLpPct = totalColl > 0 ? (coLpColl / totalColl) * 100 : 0;
    const lockedPct = totalColl > 0 ? (lockedColl / totalColl) * 100 : 0;
    const freePct = totalColl > 0 ? (freeColl / totalColl) * 100 : 0;

    const pieChart = makePieChart(usedPct, pendingPct, bufferPct, coLpPct, freePct);

    // Populate chart
    const chartEl = document.getElementById(`${prefix}-lp-chart`);
    if (chartEl) chartEl.innerHTML = pieChart;

    // Populate stats
    const set = (id, val) => { const el = document.getElementById(`${prefix}-lp-${id}`); if (el) el.innerHTML = val; };

    set('cr', `<span style="color:${crColor};text-shadow:0 0 16px ${crColor}40">${crDisplay}</span>`);
    set('collateral', `${collateral.toFixed(4)} sDAI`);
    set('debt', `${debt.toFixed(4)} wsXMR`);

    if (isMint) {
        if (vault.capacityAvailable === false && !vault.capacityEstimated) {
            set('capacity', '<span style="color:var(--amber)">unavailable</span>');
        } else {
            const cap = vault.maxMintCapacityXmr || 0;
            const estPrefix = vault.capacityEstimated ? '~' : '';
            const capStr = cap < 0.0001 ? cap.toExponential(2) : cap.toFixed(4);
            set('capacity', `${estPrefix}${capStr} XMR${vault.capacityEstimated ? ' <span style="color:var(--muted);font-size:10px">(est.)</span>' : ''}`);
        }
        const griefing = vault.mintGriefingDeposit ? Number(vault.mintGriefingDeposit) / 1e18 : 0;
        set('griefing', `${griefing.toFixed(3)} xDAI`);
    } else {
        const rewardPct = (vault.burnRewardBps || 0) / 100;
        set('reward', `${rewardPct.toFixed(2)}%`);
        const minBurn = vault.minBurnAmount ? Number(vault.minBurnAmount) / 1e8 : 0;
        set('min', `${minBurn.toFixed(4)} wsXMR`);
    }

    // Scan link
    const scanLink = document.getElementById(`${prefix}-lp-scan-link`);
    if (scanLink) scanLink.href = `https://gnosisscan.io/address/${vault.address}`;

    // Breakdown bars
    const breakdownEl = document.getElementById(`${prefix}-lp-breakdown`);
    if (breakdownEl) {
        const bars = [
            { label: 'reserved', pct: usedPct, val: usedColl, color: '#ff4444' },
            { label: 'pending', pct: pendingPct, val: pendingColl, color: '#8b5cf6' },
            { label: 'safety', pct: bufferPct, val: bufferColl, color: '#facc15' },
            { label: 'co-lp', pct: coLpPct, val: coLpColl, color: '#3b82f6' },
            { label: 'burn lock', pct: lockedPct, val: lockedColl, color: '#f97316' },
            { label: vault.capacityAvailable === false && !vault.capacityEstimated ? 'free (stale)' : (vault.capacityEstimated ? 'free (~)' : 'free'), pct: freePct, val: vault.capacityAvailable === false && !vault.capacityEstimated ? 0 : freeColl, color: vault.capacityAvailable === false && !vault.capacityEstimated ? '#666' : '#2fe6c4' },
        ];
        breakdownEl.innerHTML = bars.map(b => `
            <div class="lp-bk">
                <span class="dot" style="background:${b.color};box-shadow:0 0 6px ${b.color}60"></span>
                <span style="min-width:55px">${b.label}</span>
                <span class="bar"><span class="fill" style="width:${b.pct.toFixed(1)}%;background:${b.color}"></span></span>
                <span class="val">${b.val.toFixed(2)}</span>
            </div>
        `).join('');
    }

    // Show the card
    card.classList.remove('hidden');
}

/**
 * Wire up toggle click handlers for LP detail cards.
 */
export function initLPDetailToggles() {
    ['mint', 'burn'].forEach(prefix => {
        const toggle = document.getElementById(`${prefix}-lp-detail-toggle`);
        const card = document.getElementById(`${prefix}-lp-detail`);
        if (toggle && card) {
            toggle.addEventListener('click', () => card.classList.toggle('open'));
        }
    });
}

const MINT_STEP_MAP = {
    'init': 0,
    'evm-init': 0,
    'awaiting-lp-key': 1,
    'deposit': 1,
    'lp-confirm': 2,
    'finalize': 3
};

const MINT_STEP_NOTE = {
    'init': { num: '01', text: 'Initiating mint on-chain...' },
    'evm-init': { num: '01', text: 'Paying griefing deposit on-chain...' },
    'awaiting-lp-key': { num: '02', text: 'Waiting for LP to post transaction destination address...' },
    'deposit': { num: '02', text: 'Send XMR to the LP address shown below.' },
    'lp-confirm': { num: '03', text: 'LP is verifying your XMR deposit on the Monero blockchain...' },
    'finalize': { num: '04', text: 'Finalizing mint — revealing secret to claim wsXMR...' }
};

const BURN_STEP_MAP = {
    'init': 0,
    'evm-request': 0,
    'lp-propose': 1,
    'confirm-lock': 2,
    'lp-finalize': 3,
    'sweeping': 4,
    'sweep-failed': 4,
    'swept': 4
};

const BURN_STEP_NOTE = {
    'init': { num: '01', text: 'Requesting signature…' },
    'evm-request': { num: '01', text: 'Submitting burn request to blockchain…' },
    'lp-propose': { num: '02', text: 'Waiting for LP to send XMR to your shared address…' },
    'confirm-lock': { num: '03', text: 'Verifying XMR receipt on Monero blockchain…' },
    'lp-finalize': { num: '04', text: 'Waiting for LP to finalize and reveal secret…' },
    'sweeping': { num: '05', text: 'Claiming XMR from shared address…' },
    'sweep-failed': { num: '05', text: 'Sweep failed — use keys to claim manually, or retry.' },
    'swept': { num: '05', text: 'XMR swept to your destination.' },
    'completed': { num: '04', text: 'Burn complete — XMR claimed or keys provided.' }
};

/**
 * Update mint progress
 */
export function updateMintProgress(step, status = null) {
    const stepIndex = MINT_STEP_MAP[step];
    if (stepIndex === undefined) return;

    // Update step-note label
    const note = MINT_STEP_NOTE[step];
    if (note) {
        const numEl = document.getElementById('mint-step-num');
        const textEl = document.getElementById('mint-step-text');
        if (numEl) numEl.textContent = note.num;
        if (textEl) textEl.textContent = status || note.text;
    }

    if (!elements.mintProgress) {
        console.warn('[UI] mint-progress element not found, skipping updateMintProgress');
        return;
    }

    const steps = elements.mintProgress.querySelectorAll('.step');

    steps.forEach((stepEl, idx) => {
        if (idx === stepIndex) {
            stepEl.classList.add('cur');
            stepEl.classList.remove('done');
            const body = stepEl.querySelector('.step-body');
            if (body) {
                body.style.willChange = 'grid-template-rows';
                requestAnimationFrame(() => {
                    body.style.willChange = '';
                });
            }
            if (status) {
                const statusEl = stepEl.querySelector('.step-status');
                if (statusEl) {
                    if (status.includes('Waiting')) {
                        statusEl.innerHTML = `<svg class="spin" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:middle;margin-right:6px;color:var(--accent-orange);"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg> ${status}`;
                    } else {
                        statusEl.textContent = status;
                    }
                }
            }
        } else {
            stepEl.classList.remove('cur');
        }
    });

    elements.mintProgress.classList.remove('hidden');
    elements.mintProgress.style.display = 'block';
}

/**
 * Mark mint step as completed
 */
export function completeMintStep(step) {
    const stepIndex = MINT_STEP_MAP[step];
    if (stepIndex === undefined) return;
    if (!elements.mintProgress) return;
    const stepEl = elements.mintProgress.querySelectorAll('.step')[stepIndex];
    if (stepEl) {
        stepEl.classList.add('done');
        stepEl.classList.remove('cur');
        const statusEl = stepEl.querySelector('.step-status');
        if (statusEl && !statusEl.dataset.originalText) {
            statusEl.dataset.originalText = statusEl.textContent;
        }
        if (statusEl) {
            statusEl.textContent = 'Done';
        }
    }
}

/**
 * Show mint deposit info
 */
export async function showMintDepositInfo(address, amount) {
    // Ensure mint progress is visible - force display
    if (elements.mintProgress) {
        elements.mintProgress.classList.remove('hidden');
        elements.mintProgress.style.display = 'block';
    }
    
    // If address is still placeholder, show loading message
    if (address === 'LP_WILL_PROVIDE_ADDRESS') {
        if (elements.mintXmrAddress) {
            elements.mintXmrAddress.textContent = 'Fetching deposit address from LP node...';
        }
    } else {
        if (elements.mintXmrAddress) {
            elements.mintXmrAddress.innerHTML = `
                <span id="mint-xmr-address-text">${address}</span>
                <button id="copy-mint-address">
                    ${getIconSVG('clipboard')}
                    <span id="copy-mint-label">Copy address</span>
                </button>
            `;
            const copyBtn = document.getElementById('copy-mint-address');
            if (copyBtn) {
                copyBtn.addEventListener('click', () => {
                    navigator.clipboard.writeText(address).then(() => {
                        copyBtn.innerHTML = `${getIconSVG('check')}<span>Copied!</span>`;
                        setTimeout(() => {
                            copyBtn.innerHTML = `${getIconSVG('clipboard')}<span id="copy-mint-label">Copy address</span>`;
                        }, 2000);
                    });
                });
            }
        }
    }
    
    if (elements.mintExactAmount) {
        elements.mintExactAmount.textContent = amount.toFixed(8);
    }
    
    // Show QR code, address, and amount elements
    if (elements.mintQrCode) {
        elements.mintQrCode.style.display = 'block';
        // Force layout reflow so canvas has dimensions before drawing
        elements.mintQrCode.offsetHeight;
        try {
            await generateQRCode(elements.mintQrCode, `monero:${address}?tx_amount=${amount}`);
        } catch (e) {
            console.error('QR code generation failed:', e);
            // Draw fallback text
            const ctx = elements.mintQrCode.getContext('2d');
            elements.mintQrCode.width = 200;
            elements.mintQrCode.height = 200;
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, 200, 200);
            ctx.fillStyle = '#000000';
            ctx.font = '11px monospace';
            ctx.fillText('QR Error', 70, 95);
            ctx.fillText('Use address below', 50, 115);
        }
    }
    if (elements.mintXmrAddress) {
        elements.mintXmrAddress.style.display = 'block';
    }
    if (elements.mintExactAmount) {
        elements.mintExactAmount.style.display = 'block';
    }
    
    // Show button, hide verification status initially
    if (elements.confirmSentXmr) {
        elements.confirmSentXmr.classList.remove('hidden');
        elements.confirmSentXmr.innerHTML = `<button class="cta" style="width:100%;margin-top:12px;">I've sent the XMR</button>`;
    }
    if (elements.waitingLpVerification) {
        elements.waitingLpVerification.classList.add('hidden');
    }

    if (elements.mintDepositInfo) {
        elements.mintDepositInfo.classList.remove('hidden');
        elements.mintDepositInfo.style.display = 'block';
    }
    if (elements.mintActions) {
        elements.mintActions.classList.remove('hidden');
    }
}

/**
 * Show LP verification status (after user confirms they sent XMR)
 */
export function showLPVerificationStatus() {
    if (elements.confirmSentXmr) {
        elements.confirmSentXmr.classList.add('hidden');
    }
    
    // Show deposit info by default so user can see the address they sent to
    if (elements.mintDepositInfo) {
        elements.mintDepositInfo.classList.remove('hidden');
    }
    
    // Keep deposit step body expanded so the verification status and toggle button are visible
    const depositStep = elements.mintProgress?.querySelectorAll('.step')[1];
    if (depositStep) {
        const body = depositStep.querySelector('.step-body');
        if (body) body.classList.add('force-open');
    }

    if (elements.waitingLpVerification) {
        elements.waitingLpVerification.classList.remove('hidden');
        elements.waitingLpVerification.innerHTML = `
            <svg class="spin" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:middle;margin-right:6px;color:var(--accent-orange);"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg> 
            Waiting for LP to verify your transaction...
            <br>
            <span style="font-size:0.8rem;color:var(--text-muted);margin-left:20px;display:block;margin-top:4px;">
                The LP waits for 10+ Monero blockchain confirmations before marking your deposit as verified (~15–30 min).
            </span>
        `;
    }

}

/**
 * Show "Claim wsXMR" button after LP confirms receipt
 */
export function showClaimWsXmrButton(onClaim) {
    // Hide verification status
    if (elements.waitingLpVerification) {
        elements.waitingLpVerification.classList.add('hidden');
    }
    
    // Hide deposit info (QR code, address, amount, confirm sent button)
    if (elements.mintDepositInfo) {
        elements.mintDepositInfo.classList.add('hidden');
        elements.mintDepositInfo.style.display = 'none';
    }
    if (elements.mintQrCode) {
        elements.mintQrCode.style.display = 'none';
    }
    if (elements.mintXmrAddress) {
        elements.mintXmrAddress.style.display = 'none';
    }
    if (elements.mintExactAmount) {
        elements.mintExactAmount.style.display = 'none';
    }
    if (elements.confirmSentXmr) {
        elements.confirmSentXmr.classList.add('hidden');
    }
    
    // Ensure mint actions container exists
    let container = elements.mintActions;
    if (!container) {
        // Fallback: find or create the mint panel actions area
        container = document.getElementById('mint-actions');
        if (!container) {
            // Last resort: use the mint panel itself
            container = document.getElementById('mint-panel') || document.body;
        }
        elements.mintActions = container;
    }
    
    // Make sure the container is visible
    container.classList.remove('hidden');
    container.style.display = 'block';
    
    // Create or show claim button
    let claimButton = container.querySelector('.claim-wsxmr-btn');
    if (!claimButton) {
        claimButton = document.createElement('button');
        claimButton.className = 'btn btn-primary claim-wsxmr-btn';
        claimButton.innerHTML = `
            <span class="claim-glow"></span>
            <span class="claim-content">
                <span class="claim-icon">${getIconSVG('zap')}</span>
                <span class="claim-text">Claim wsXMR</span>
            </span>
        `;
        container.appendChild(claimButton);
    }

    claimButton.classList.remove('hidden');
    claimButton.onclick = onClaim;

    // Hide the Cancel & Refund button once LP has confirmed
    if (elements.cancelMint) {
        elements.cancelMint.classList.add('hidden');
    }

    // Update progress message
    updateMintProgress('lp-confirm', 'LP confirmed! Click to claim your wsXMR tokens.');
}

/**
 * Update burn progress
 */
export function updateBurnProgress(step, status = null) {
    const stepIndex = BURN_STEP_MAP[step];
    if (stepIndex === undefined) return;

    if (!elements.burnProgress) {
        console.warn('[UI] burn-progress element not found, skipping updateBurnProgress');
        return;
    }

    // Update step-note label
    const note = BURN_STEP_NOTE[step];
    if (note) {
        const numEl = document.getElementById('burn-step-num');
        const textEl = document.getElementById('burn-step-text');
        if (numEl) numEl.textContent = note.num;
        if (textEl) textEl.textContent = note.text;
    }

    const steps = elements.burnProgress.querySelectorAll('.step');

    steps.forEach((stepEl, idx) => {
        if (idx === stepIndex) {
            stepEl.classList.add('cur');
            stepEl.classList.remove('done');
        } else {
            stepEl.classList.remove('cur');
        }
    });

    // Update dynamic loading indicator
    const loadingEl = document.getElementById('burn-status-loading');
    if (loadingEl) {
        if (status) {
            loadingEl.classList.remove('hidden');
            const isWaiting = status.includes('Waiting') || status.includes('Scanning') || status.includes('Submitting');
            const spinnerSvg = `<svg class="spin" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>`;
            let detail = '';
            if (step === 'lp-propose') {
                detail = '<span class="burn-status-detail">The LP server generates a secret, sends XMR to your shared Monero address, and commits the secret hash on-chain. This typically takes 1–5 minutes.</span>';
            } else if (step === 'confirm-lock') {
                detail = '<span class="burn-status-detail">Scanning the Monero blockchain with your view key to verify the LP sent XMR to the shared address.</span>';
            } else if (step === 'lp-finalize') {
                detail = '<span class="burn-status-detail">The LP reveals its secret on-chain, which lets you combine keys and sweep XMR to your destination.</span>';
            } else if (step === 'evm-request') {
                detail = '<span class="burn-status-detail">Submitting the burn transaction to the EVM chain. Your wsXMR is burned and the LP is notified.</span>';
            }
            loadingEl.innerHTML = `${isWaiting ? spinnerSvg : '<span style="font-size:16px;">✓</span>'} <span>${status}${detail}</span>`;
        } else {
            loadingEl.classList.add('hidden');
        }
    }

    elements.burnProgress.classList.remove('hidden');
    elements.burnProgress.style.display = 'block';
}

/**
 * Mark burn step as completed
 */
export function completeBurnStep(step) {
    const stepIndex = BURN_STEP_MAP[step];
    if (stepIndex === undefined) return;
    const stepEl = elements.burnProgress?.querySelectorAll('.step')[stepIndex];
    if (stepEl) {
        stepEl.classList.add('done');
        stepEl.classList.remove('cur');
    }
}

/**
 * Show a simple info modal (one Close button).
 */
export function showModal(title, body, isError = false) {
    // Reset to simple mode: only Close button visible
    if (elements.modalCloseBtn) elements.modalCloseBtn.classList.remove('hidden');
    if (elements.modalCancelBtn) elements.modalCancelBtn.classList.add('hidden');
    if (elements.modalConfirmBtn) elements.modalConfirmBtn.classList.add('hidden');
    if (elements.modalXBtn) elements.modalXBtn.classList.remove('hidden');

    elements.modalTitle.textContent = title;
    elements.modalBody.innerHTML = body;
    elements.modalOverlay.classList.remove('hidden');
}

/**
 * Show a confirm modal with Confirm / Cancel buttons.
 * Returns a Promise that resolves to true (confirmed) or false (cancelled).
 */
export function showConfirmModal(title, body) {
    return new Promise((resolve) => {
        // Hide Close button, show Confirm/Cancel
        if (elements.modalCloseBtn) elements.modalCloseBtn.classList.add('hidden');
        if (elements.modalCancelBtn) elements.modalCancelBtn.classList.remove('hidden');
        if (elements.modalConfirmBtn) elements.modalConfirmBtn.classList.remove('hidden');
        if (elements.modalXBtn) elements.modalXBtn.classList.remove('hidden');

        elements.modalTitle.textContent = title;
        elements.modalBody.innerHTML = body;
        elements.modalOverlay.classList.remove('hidden');

        // One-time handlers
        const onConfirm = () => {
            cleanup();
            resolve(true);
        };
        const onCancel = () => {
            cleanup();
            resolve(false);
        };
        const onOverlay = (e) => {
            if (e.target === elements.modalOverlay) {
                cleanup();
                resolve(false);
            }
        };

        const cleanup = () => {
            hideModal();
            elements.modalConfirmBtn.removeEventListener('click', onConfirm);
            elements.modalCancelBtn.removeEventListener('click', onCancel);
            elements.modalXBtn.removeEventListener('click', onCancel);
            elements.modalOverlay.removeEventListener('click', onOverlay);
        };

        elements.modalConfirmBtn.addEventListener('click', onConfirm);
        elements.modalCancelBtn.addEventListener('click', onCancel);
        elements.modalXBtn.addEventListener('click', onCancel);
        elements.modalOverlay.addEventListener('click', onOverlay);
    });
}

/**
 * Hide modal
 */
export function hideModal() {
    elements.modalOverlay.classList.add('hidden');
}

/**
 * Show success modal
 */
export function showCoLPTab() {
    console.log('[UI] Switching to Co-LP tab');
    elements.tabCoLP.classList.add('active');
    elements.tabMint.classList.remove('active');
    elements.tabBurn.classList.remove('active');
    elements.tabLp.classList.remove('active');
    elements.coLPPanel.classList.remove('hidden');
    elements.mintPanel.classList.add('hidden');
    elements.burnPanel.classList.add('hidden');
    elements.lpPanel.classList.add('hidden');
    saveActiveTab('co-lp');
}

export function showSuccess(title, message) {
    showModal(title, `<p style="color: var(--success-color);">${message}</p>`);
}

/**
 * Show mint complete inline banner + confetti (no modal)
 */
export function showMintComplete(amount) {
    const mintPanel = document.getElementById('mint-panel');
    if (!mintPanel) return;

    // Remove any existing banner
    const existing = mintPanel.querySelector('.mint-complete-banner');
    if (existing) existing.remove();

    const banner = document.createElement('div');
    banner.className = 'mint-complete-banner';
    banner.innerHTML = `
        <div class="mint-complete-inner">
            <h3>Mint Complete</h3>
            <p>Successfully minted ${amount} wsXMR!</p>
        </div>
        <span class="mint-complete-timer">0s ago</span>
    `;
    mintPanel.insertBefore(banner, mintPanel.firstChild);

    const timerEl = banner.querySelector('.mint-complete-timer');
    let seconds = 0;
    const timerId = setInterval(() => {
        seconds++;
        if (seconds >= 60) {
            clearInterval(timerId);
            banner.remove();
            return;
        }
        if (timerEl) {
            timerEl.textContent = seconds + 's ago';
        }
    }, 1000);

    launchMintCelebration();
}

/**
 * Show burn complete inline banner + fire animation (no modal)
 */
export function showBurnComplete(amount) {
    const burnPanel = document.getElementById('burn-panel');
    if (!burnPanel) return;

    const existing = burnPanel.querySelector('.burn-complete-banner');
    if (existing) existing.remove();

    const banner = document.createElement('div');
    banner.className = 'burn-complete-banner';
    banner.innerHTML = `
        <div class="burn-complete-inner">
            <h3>Burn Complete</h3>
            <p>Successfully burned ${amount} wsXMR!</p>
        </div>
        <span class="burn-complete-timer">0s ago</span>
    `;
    burnPanel.insertBefore(banner, burnPanel.firstChild);

    const timerEl = banner.querySelector('.burn-complete-timer');
    let seconds = 0;
    const timerId = setInterval(() => {
        seconds++;
        if (seconds >= 60) {
            clearInterval(timerId);
            banner.remove();
            return;
        }
        if (timerEl) {
            timerEl.textContent = seconds + 's ago';
        }
    }, 1000);

    launchBurnAnimation();
}

/**
 * Show burn verification loading state
 */
export function showBurnVerificationLoading() {
    const loading = document.getElementById('burn-verification-loading');
    const details = document.getElementById('burn-verification-details');
    const manual = document.getElementById('burn-verification-manual');
    if (loading) loading.classList.remove('hidden');
    if (details) details.classList.add('hidden');
    if (manual) manual.classList.add('hidden');
}

/**
 * Show burn verification details inline
 * @param {Object} details - { destination, txHash, confirmations, amount }
 */
export function showBurnVerificationDetails(details) {
    const loading = document.getElementById('burn-verification-loading');
    const detailsEl = document.getElementById('burn-verification-details');
    const manual = document.getElementById('burn-verification-manual');

    if (loading) loading.classList.add('hidden');
    if (manual) manual.classList.add('hidden');
    if (detailsEl) {
        detailsEl.classList.remove('hidden');

        const addrEl = document.getElementById('burn-verify-address');
        const txHashEl = document.getElementById('burn-verify-tx-hash');
        const txLinkEl = document.getElementById('burn-verify-tx-link');
        const confsEl = document.getElementById('burn-verify-confirmations');
        const amountEl = document.getElementById('burn-verify-amount');

        if (addrEl) addrEl.textContent = details.destination || '';
        if (txHashEl) txHashEl.textContent = details.txHash || '';
        if (txLinkEl) {
            txLinkEl.href = details.txHash
                ? `https://xmrchain.net/tx/${details.txHash}`
                : '#';
        }
        if (confsEl) {
            confsEl.textContent = details.confirmations !== undefined
                ? `${details.confirmations} confirmation${details.confirmations !== 1 ? 's' : ''}`
                : 'Unknown';
        }
        if (amountEl) {
            amountEl.textContent = details.amount !== undefined ? `${details.amount} XMR` : 'Unknown';
        }
    }
}

/**
 * Show manual burn confirmation option
 */
export function showBurnVerificationManual() {
    const loading = document.getElementById('burn-verification-loading');
    const details = document.getElementById('burn-verification-details');
    const manual = document.getElementById('burn-verification-manual');
    if (loading) loading.classList.add('hidden');
    if (details) details.classList.add('hidden');
    if (manual) manual.classList.remove('hidden');
}

/**
 * Show burn XMR scan progress (view-only wallet scanning)
 * @param {string} message - Progress message
 * @param {number|null} foundAmount - Amount found in atomic units, or null if not yet found
 */
export function showBurnScanProgress(message, foundAmount = null) {
    const loading = document.getElementById('burn-verification-loading');
    const details = document.getElementById('burn-verification-details');
    const manual = document.getElementById('burn-verification-manual');

    if (loading) {
        loading.classList.remove('hidden');
        loading.innerHTML = `
            <svg class="spin" xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="color:var(--accent-orange);"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
            <span>${message}</span>
        `;
    }
    if (details) details.classList.add('hidden');
    // Keep manual buttons visible so user can confirm manually while scan runs
    if (manual) manual.classList.remove('hidden');
}

/**
 * Show burn XMR found state (auto-verified)
 * @param {string} amount - Amount in XMR (human readable)
 * @param {number} confirmations - Number of confirmations
 */
export function showBurnXmrFound(amount, confirmations) {
    const loading = document.getElementById('burn-verification-loading');
    const details = document.getElementById('burn-verification-details');
    const manual = document.getElementById('burn-verification-manual');

    if (loading) loading.classList.add('hidden');
    if (manual) manual.classList.add('hidden');
    if (details) {
        details.classList.remove('hidden');
        const amountEl = document.getElementById('burn-verify-amount');
        const confsEl = document.getElementById('burn-verify-confirmations');
        if (amountEl) amountEl.textContent = `${amount} XMR ✓`;
        if (confsEl) confsEl.textContent = `${confirmations} confirmation${confirmations !== 1 ? 's' : ''}`;
    }
}

/**
 * Show burn address panel with Monero address and view key
 * @param {Object} data - { moneroAddress, viewKey }
 */
export function showBurnAddressPanel(data) {
    const panel = document.getElementById('burn-address-panel');
    const addressEl = document.getElementById('burn-monero-address');
    const viewKeyEl = document.getElementById('burn-view-key');
    
    if (panel && addressEl && viewKeyEl) {
        addressEl.textContent = data.moneroAddress || '';
        viewKeyEl.textContent = data.viewKey || '';
        panel.classList.remove('hidden');
    }

    // Wire up copy buttons
    const copyAddr = document.getElementById('copy-burn-address');
    const copyView = document.getElementById('copy-burn-viewkey');
    if (copyAddr) {
        copyAddr.onclick = async () => {
            await navigator.clipboard.writeText(data.moneroAddress || '');
            copyAddr.textContent = 'Copied!';
            setTimeout(() => copyAddr.textContent = 'Copy', 2000);
        };
    }
    if (copyView) {
        copyView.onclick = async () => {
            await navigator.clipboard.writeText(data.viewKey || '');
            copyView.textContent = 'Copied!';
            setTimeout(() => copyView.textContent = 'Copy', 2000);
        };
    }

    // Hide the generic loading indicator — LP has committed
    const loadingEl = document.getElementById('burn-status-loading');
    if (loadingEl) loadingEl.classList.add('hidden');
}

/**
 * Show burn sweep progress (claiming XMR from shared address)
 * @param {string} message - Progress message
 */
export function showBurnSweepProgress(message) {
    const burnPanel = document.getElementById('burn-panel');
    if (!burnPanel) return;

    // Hide cancel button during sweep
    const cancelBtn = document.getElementById('cancel-burn');
    if (cancelBtn) cancelBtn.classList.add('hidden');

    let el = document.getElementById('burn-sweep-progress');
    if (!el) {
        el = document.createElement('div');
        el.id = 'burn-sweep-progress';
        el.className = 'burn-sweep-progress';
        burnPanel.appendChild(el);
    }

    el.innerHTML = `
        <div class="sweep-spinner"></div>
        <p>${message}</p>
    `;
    el.classList.remove('hidden');
}

/**
 * Show burn sweep complete
 * @param {string} txHash - Monero transaction hash
 * @param {number} amount - Amount in XMR
 */
export function showBurnSweepComplete(txHash, amount) {
    const burnPanel = document.getElementById('burn-panel');
    if (!burnPanel) return;

    const progressEl = document.getElementById('burn-sweep-progress');
    if (progressEl) progressEl.classList.add('hidden');

    // Hide cancel button on completion
    const cancelBtn = document.getElementById('cancel-burn');
    if (cancelBtn) cancelBtn.classList.add('hidden');

    let el = document.getElementById('burn-sweep-complete');
    if (!el) {
        el = document.createElement('div');
        el.id = 'burn-sweep-complete';
        el.className = 'burn-sweep-complete';
        burnPanel.appendChild(el);
    }

    el.innerHTML = `
        <div class="burn-complete-inner">
            <h3>XMR Received!</h3>
            <p>Swept ${amount.toFixed(8)} XMR to your destination address</p>
            <p class="text-muted">Tx: ${txHash.slice(0, 16)}...${txHash.slice(-16)}</p>
        </div>
    `;
    el.classList.remove('hidden');
}

/**
 * Show burn sweep error
 * @param {string} errorMsg - Error message
 */
export function showBurnSweepError(errorMsg) {
    const burnPanel = document.getElementById('burn-panel');
    if (!burnPanel) return;

    const progressEl = document.getElementById('burn-sweep-progress');
    if (progressEl) progressEl.classList.add('hidden');

    const completeEl = document.getElementById('burn-sweep-complete');
    if (completeEl) completeEl.classList.add('hidden');

    let el = document.getElementById('burn-sweep-error');
    if (!el) {
        el = document.createElement('div');
        el.id = 'burn-sweep-error';
        el.className = 'burn-sweep-error';
        burnPanel.appendChild(el);
    }

    let friendly = 'An unexpected error occurred while sweeping XMR to your destination address.';
    let detail = errorMsg;

    if (errorMsg.includes('No unlocked balance') || errorMsg.includes('balance is 0')) {
        friendly = 'The XMR at the shared address is not yet unlocked. Monero requires ~10 confirmations before funds can be spent. Please wait and try again.';
    } else if (errorMsg.includes('No balance') || errorMsg.includes('no funds')) {
        friendly = 'No XMR found at the shared address. The LP may not have sent XMR yet.';
    } else if (errorMsg.includes('daemon') || errorMsg.includes('connection') || errorMsg.includes('fetch')) {
        friendly = 'Could not connect to the Monero network. Please check your internet connection and try again.';
    } else if (errorMsg.includes('WASM') || errorMsg.includes('wasm') || errorMsg.includes('module not loaded')) {
        friendly = 'The Monero WASM module failed to load. Please refresh the page and try again.';
    }

    el.innerHTML = `
        <div class="burn-sweep-error-inner">
            <div class="burn-sweep-error-icon">
                <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <circle cx="12" cy="12" r="10"/>
                    <line x1="12" y1="8" x2="12" y2="12"/>
                    <line x1="12" y1="16" x2="12.01" y2="16"/>
                </svg>
            </div>
            <div class="burn-sweep-error-content">
                <h3>Sweep Failed</h3>
                <p class="burn-sweep-error-friendly">${friendly}</p>
                <details class="burn-sweep-error-details">
                    <summary>Technical details</summary>
                    <p>${detail}</p>
                </details>
            </div>
        </div>
        <div class="burn-sweep-error-actions">
            <button class="cta" id="burn-sweep-retry">
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline;vertical-align:-2px;margin-right:4px"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
                Retry sweep
            </button>
        </div>
    `;
    el.classList.remove('hidden');

    const retryBtn = document.getElementById('burn-sweep-retry');
    if (retryBtn) {
        retryBtn.addEventListener('click', () => {
            el.classList.add('hidden');
            showBurnSweepProgress('Retrying sweep...');
            window.dispatchEvent(new CustomEvent('burn-sweep-retry'));
        });
    }
}

/**
 * Show a non-intrusive "Copy keys for manual import" button during burn sweep.
 * Lets user proactively copy combined keys without waiting for a sweep failure.
 * @param {Object} keys - { spendKey, viewKey } (little-endian hex, no 0x)
 * @param {string} destination - User's destination address
 */
export function showBurnKeysOption(keys, destination) {
    const burnPanel = document.getElementById('burn-panel');
    if (!burnPanel) return;

    let el = document.getElementById('burn-keys-option');
    if (!el) {
        el = document.createElement('div');
        el.id = 'burn-keys-option';
        el.className = 'burn-keys-option';
        el.style.cssText = 'margin-top: 12px; text-align: center;';
        burnPanel.appendChild(el);
    }

    el.innerHTML = `<button class="btn-secondary" id="burn-copy-keys-btn" style="font-size: 0.85rem; opacity: 0.8;">Copy keys for manual import</button>`;
    el.classList.remove('hidden');

    const btn = document.getElementById('burn-copy-keys-btn');
    if (btn) {
        btn.addEventListener('click', () => {
            showBurnKeysFallback(keys, destination);
        });
    }
}

/**
 * Hide the burn keys option button (call when sweep succeeds)
 */
export function hideBurnKeysOption() {
    const el = document.getElementById('burn-keys-option');
    if (el) el.classList.add('hidden');
}

/**
 * Show burn keys fallback modal (copy-only, no on-screen key display)
 * Lets user copy combined private keys for manual import into Monero GUI wallet
 * @param {Object} keys - { spendKey, viewKey } (little-endian hex, no 0x)
 * @param {string} destination - User's destination address
 */
export function showBurnKeysFallback(keys, destination) {
    const burnPanel = document.getElementById('burn-panel');
    if (!burnPanel) return;

    // Remove any existing overlay modal
    const existing = document.getElementById('burn-keys-fallback-overlay');
    if (existing) existing.remove();

    let el = document.getElementById('burn-keys-fallback');
    if (!el) {
        el = document.createElement('div');
        el.id = 'burn-keys-fallback';
        el.className = 'burn-keys-fallback';
        burnPanel.appendChild(el);
    }

    el.innerHTML = `
        <div class="burn-keys-fallback-header">
            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex-shrink:0;color:var(--amber)"><path d="M12 2L15.09 8.26L22 9.27L17 14.14L18.18 21.02L12 17.77L5.82 21.02L7 14.14L2 9.27L8.91 8.26L12 2Z"/></svg>
            <span>Automatic sweep failed — claim your XMR manually</span>
        </div>
        <p class="burn-keys-fallback-desc">Import these keys into a Monero wallet (Monero GUI, Feather Wallet) to access your funds:</p>
        <div class="burn-keys-fallback-steps">
            <span>1. Copy the private spend key and view key below</span>
            <span>2. Open Monero GUI Wallet → Restore from keys</span>
            <span>3. Paste the keys and set restore height</span>
            <span>4. Wait for sync, then sweep all to your destination</span>
        </div>
        <div class="burn-keys-fallback-keys">
            <div class="burn-key-row">
                <label>Private Spend Key</label>
                <div class="burn-key-copy">
                    <input type="password" id="fallback-spend-key" value="${keys.spendKey}" readonly>
                    <button class="btn-copy-sm" id="fallback-copy-spend">Copy</button>
                </div>
            </div>
            <div class="burn-key-row">
                <label>Private View Key</label>
                <div class="burn-key-copy">
                    <input type="password" id="fallback-view-key" value="${keys.viewKey}" readonly>
                    <button class="btn-copy-sm" id="fallback-copy-view">Copy</button>
                </div>
            </div>
            <div class="burn-key-row">
                <label>Destination Address</label>
                <p class="burn-key-dest">${destination}</p>
            </div>
        </div>
    `;
    el.classList.remove('hidden');

    const copySpend = document.getElementById('fallback-copy-spend');
    const copyView = document.getElementById('fallback-copy-view');

    if (copySpend) {
        copySpend.addEventListener('click', async () => {
            await navigator.clipboard.writeText(keys.spendKey);
            copySpend.textContent = 'Copied!';
            setTimeout(() => copySpend.textContent = 'Copy', 2000);
        });
    }

    if (copyView) {
        copyView.addEventListener('click', async () => {
            await navigator.clipboard.writeText(keys.viewKey);
            copyView.textContent = 'Copied!';
            setTimeout(() => copyView.textContent = 'Copy', 2000);
        });
    }
}

/**
 * Show error modal
 */
export function showError(title, message) {
    showModal(title, `<p style="color: var(--error-color);">${message}</p>`, true);
}

/**
 * Show slide-in notification
 * @param {string} title - Notification title
 * @param {string} message - Notification message (can include HTML)
 * @param {string} type - Notification type: 'info', 'success', 'error', 'warning'
 * @param {number} duration - Auto-dismiss duration in ms (0 = no auto-dismiss)
 */
export function showNotification(title, message, type = 'info', duration = 5000) {
    const container = document.getElementById('notification-container');
    if (!container) return;

    const notification = document.createElement('div');
    notification.className = `notification ${type}`;
    
    const notificationId = `notif-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    notification.id = notificationId;
    
    notification.innerHTML = `
        <div class="notification-header">
            <div class="notification-title">${title}</div>
            <button class="notification-close" aria-label="Close">&times;</button>
        </div>
        <div class="notification-body">${message}</div>
    `;
    
    container.appendChild(notification);
    
    const closeBtn = notification.querySelector('.notification-close');
    const dismiss = () => {
        notification.classList.add('slide-out');
        setTimeout(() => {
            if (notification.parentNode) {
                notification.parentNode.removeChild(notification);
            }
        }, 250);
    };
    
    closeBtn.addEventListener('click', dismiss);
    
    if (duration > 0) {
        setTimeout(dismiss, duration);
    }
    
    return notificationId;
}

/**
 * Show success notification
 */
export function showSuccessNotification(title, message, duration = 5000) {
    return showNotification(title, message, 'success', duration);
}

/**
 * Show error notification
 */
export function showErrorNotification(title, message, duration = 7000) {
    return showNotification(title, message, 'error', duration);
}

/**
 * Show warning notification
 */
export function showWarningNotification(title, message, duration = 6000) {
    return showNotification(title, message, 'warning', duration);
}

/**
 * Show info notification
 */
export function showInfoNotification(title, message, duration = 5000) {
    return showNotification(title, message, 'info', duration);
}

/**
 * Format address for display
 */
function formatAddress(address) {
    if (!address) return '';
    return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

/**
 * Format balance for display
 */
function formatBalance(balance, decimals) {
    if (!balance) return '0.00';
    const value = Number(balance) / Math.pow(10, decimals);
    return value.toFixed(decimals === 8 ? 8 : 4);
}

/**
 * Generate QR code
 * Uses qrcode library to generate actual QR codes
 */
async function generateQRCode(canvas, data) {
    try {
        // Dynamically import qrcode library
        const QRCode = await import('https://cdn.jsdelivr.net/npm/qrcode@1.5.3/+esm');
        
        // Generate QR code on canvas
        await QRCode.toCanvas(canvas, data, {
            width: 200,
            margin: 2,
            color: {
                dark: '#000000',
                light: '#FFFFFF'
            }
        });
        
        console.log('QR code generated for:', data);
    } catch (error) {
        console.error('Failed to generate QR code:', error);
        
        // Fallback to placeholder
        const ctx = canvas.getContext('2d');
        canvas.width = 200;
        canvas.height = 200;
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, 200, 200);
        ctx.fillStyle = '#000000';
        ctx.font = '12px monospace';
        ctx.fillText('QR Code Error', 50, 100);
    }
}

/**
 * Setup copy button handlers
 */
export function setupCopyButtons() {
    document.querySelectorAll('.btn-copy').forEach(btn => {
        btn.addEventListener('click', () => {
            const targetId = btn.getAttribute('data-copy');
            const targetEl = document.getElementById(targetId);

            if (targetEl) {
                const text = targetEl.textContent;
                navigator.clipboard.writeText(text).then(() => {
                    btn.innerHTML = getIconSVG('check');
                    setTimeout(() => {
                        btn.innerHTML = getIconSVG('clipboard');
                    }, 2000);
                });
            }
        });
    });
}

/**
 * Disable form inputs
 */
export function disableInputs(isMint = true) {
    if (isMint) {
        elements.mintAmount.disabled = true;
        elements.mintVaultSelect.disabled = true;
        setVaultPickerDisabled('mint', true);
    } else {
        elements.burnAmount.disabled = true;
        elements.burnXmrDestination.disabled = true;
        elements.burnVaultSelect.disabled = true;
        elements.startBurn.disabled = true;
        setVaultPickerDisabled('burn', true);
    }
}

/**
 * Enable form inputs
 */
export function enableInputs(isMint = true) {
    if (isMint) {
        elements.mintAmount.disabled = false;
        elements.mintVaultSelect.disabled = false;
        setVaultPickerDisabled('mint', false);
    } else {
        elements.burnAmount.disabled = false;
        elements.burnXmrDestination.disabled = false;
        elements.burnVaultSelect.disabled = false;
        elements.startBurn.disabled = false;
        setVaultPickerDisabled('burn', false);
    }
}

/**
 * Reset mint UI — fully clear all mint-related DOM elements
 */
export function resetMintUI() {
    elements.mintProgress?.classList.add('hidden');
    elements.mintDepositInfo?.classList.add('hidden');
    elements.mintActions?.classList.add('hidden');
    elements.previousMintBanner?.classList.add('hidden');
    enableInputs(true);

    // Remove claim button
    const claimBtn = elements.mintActions?.querySelector('.claim-wsxmr-btn');
    if (claimBtn) claimBtn.remove();

    // Remove toggle-deposit-details button
    const toggleBtn = document.getElementById('toggle-deposit-details');
    if (toggleBtn) toggleBtn.remove();

    // Remove any refund buttons from timer container
    document.querySelectorAll('.btn-refund').forEach(b => b.remove());

    // Reset deadline timer container
    const timerContainer = document.getElementById('mint-deadline-timer');
    if (timerContainer) {
        timerContainer.classList.add('hidden');
        timerContainer.classList.remove('alert-error', 'alert-warning');
    }
    const timerEl = document.getElementById('mint-time-remaining');
    if (timerEl) timerEl.innerHTML = '';
    const warningEl = document.getElementById('mint-deadline-warning');
    if (warningEl) { warningEl.classList.add('hidden'); warningEl.innerHTML = ''; }

    // Clear verification status
    if (elements.waitingLpVerification) {
        elements.waitingLpVerification.classList.add('hidden');
        elements.waitingLpVerification.innerHTML = '';
    }

    // Clear deposit info content
    if (elements.mintDepositInfo) elements.mintDepositInfo.innerHTML = '';
    if (elements.mintXmrAddress) { elements.mintXmrAddress.innerHTML = ''; elements.mintXmrAddress.style.display = ''; }
    if (elements.mintExactAmount) { elements.mintExactAmount.textContent = ''; elements.mintExactAmount.style.display = ''; }

    // Clear QR code canvas
    if (elements.mintQrCode) {
        const ctx = elements.mintQrCode.getContext('2d');
        ctx.clearRect(0, 0, elements.mintQrCode.width, elements.mintQrCode.height);
        elements.mintQrCode.style.display = '';
    }

    // Hide confirm-sent button
    if (elements.confirmSentXmr) elements.confirmSentXmr.classList.add('hidden');

    // Reset all step states (remove done/cur classes)
    elements.mintProgress?.querySelectorAll('.step').forEach(s => {
        s.classList.remove('done', 'cur');
        const statusEl = s.querySelector('.step-status');
        if (statusEl) { statusEl.textContent = ''; delete statusEl.dataset.originalText; }
    });

    // Reset step note
    const stepNumEl = document.getElementById('mint-step-num');
    if (stepNumEl) stepNumEl.textContent = '01';
    const stepTextEl = document.getElementById('mint-step-text');
    if (stepTextEl) stepTextEl.textContent = '';

    // Clean up any forced-open step bodies
    elements.mintProgress?.querySelectorAll('.step-body.force-open').forEach(b => b.classList.remove('force-open'));

    if (elements.cancelMint) elements.cancelMint.classList.remove('hidden');
    const btnText = elements.startMint?.querySelector('.btn-text');
    if (btnText) btnText.textContent = 'Start Mint';
}

/**
 * Update Start Mint button text
 */
export function setStartMintButtonText(text) {
    const btnText = elements.startMint?.querySelector('.btn-text');
    if (btnText) btnText.textContent = text;
}

/**
 * Show a clickable banner to resume a previous mint
 */
export function showPreviousMintBanner(swap, onClick) {
    if (!elements.previousMintBanner || !swap) return;
    const stateLabel = formatSwapState(swap.state);
    const shortId = swap.requestId ? `${swap.requestId.slice(0, 6)}...${swap.requestId.slice(-4)}` : '';
    const amount = swap.xmrAmount ? `${typeof swap.xmrAmount === 'number' ? swap.xmrAmount.toFixed(4) : swap.xmrAmount} XMR` : '';
    elements.previousMintBanner.innerHTML = `
        <span style="cursor: pointer; display: flex; align-items: center; gap: 0.5rem;" class="previous-mint-link">
            <span style="color: var(--primary);">&#8592;</span>
            <span>Back to <strong>Mint ${shortId}</strong> ${amount ? `(${amount})` : ''} &mdash; ${stateLabel}</span>
        </span>
    `;
    const link = elements.previousMintBanner.querySelector('.previous-mint-link');
    if (link && onClick) {
        link.addEventListener('click', onClick);
    }
    elements.previousMintBanner.classList.remove('hidden');
}

/**
 * Hide the previous mint banner
 */
export function hidePreviousMintBanner() {
    if (elements.previousMintBanner) {
        elements.previousMintBanner.classList.add('hidden');
        elements.previousMintBanner.innerHTML = '';
    }
}

/**
 * Reset burn UI
 */
export function resetBurnUI() {
    elements.burnProgress.classList.add('hidden');
    if (elements.cancelBurn) elements.cancelBurn.classList.remove('hidden');
    enableInputs(false);
}

/**
 * Format a number nicely: up to 4 decimals, never rounds small values to 0
 */
function fmtCapacity(val) {
    if (val === 0) return '0';
    if (val < 0.0001) return val.toExponential(2);
    const s = val.toFixed(4);
    return s.replace(/\.?0+$/, '');
}

/**
 * Generate inline SVG donut chart for vault capacity
 * Slices: reserved (orange), pending (purple), safety buffer (yellow), co-lp (blue), free (green)
 */
function makePieChart(usedPct, pendingPct, bufferPct, coLpPct, freePct) {
    const size = 100;
    const cx = size / 2;
    const cy = size / 2;
    const r = 40;
    const strokeW = 12;
    const circ = +(2 * Math.PI * r).toFixed(2);

    let usedLen = +(usedPct / 100 * circ).toFixed(2);
    let pendingLen = +(pendingPct / 100 * circ).toFixed(2);
    let bufferLen = +(bufferPct / 100 * circ).toFixed(2);
    let coLpLen = +(coLpPct / 100 * circ).toFixed(2);
    let freeLen = +(freePct / 100 * circ).toFixed(2);

    // Clamp
    usedLen = Math.min(usedLen, circ);
    pendingLen = Math.min(pendingLen, circ);
    bufferLen = Math.min(bufferLen, circ);
    coLpLen = Math.min(coLpLen, circ);
    freeLen = Math.min(freeLen, circ);

    // Guard against NaN / Infinity
    if (!Number.isFinite(usedLen)) usedLen = 0;
    if (!Number.isFinite(pendingLen)) pendingLen = 0;
    if (!Number.isFinite(bufferLen)) bufferLen = 0;
    if (!Number.isFinite(coLpLen)) coLpLen = 0;
    if (!Number.isFinite(freeLen)) freeLen = circ;

    // Build SVG — stacked circles with dash offsets
    const usedDash = `${usedLen} ${circ}`;
    const pendingDash = `${pendingLen} ${circ}`;
    const bufferDash = `${bufferLen} ${circ}`;
    const coLpDash = `${coLpLen} ${circ}`;
    const freeDash = `${freeLen} ${circ}`;
    const pendingOff = -usedLen;
    const bufferOff = -(usedLen + pendingLen);
    const coLpOff = -(usedLen + pendingLen + bufferLen);
    const freeOff = -(usedLen + pendingLen + bufferLen + coLpLen);

    return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
        <defs>
          <filter id="glow">
            <feGaussianBlur stdDeviation="1.5" result="coloredBlur"/>
            <feMerge>
              <feMergeNode in="coloredBlur"/>
              <feMergeNode in="SourceGraphic"/>
            </feMerge>
          </filter>
        </defs>
        <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="rgba(255,255,255,0.03)" stroke-width="${strokeW}"/>
        <g transform="rotate(-90 ${cx} ${cy})" filter="url(#glow)">
          <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#ff4444" stroke-width="${strokeW}" stroke-dasharray="${usedDash}" stroke-linecap="round" opacity="0.85"/>
          <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#8b5cf6" stroke-width="${strokeW}" stroke-dasharray="${pendingDash}" stroke-dashoffset="${pendingOff}" stroke-linecap="round" opacity="0.85"/>
          <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#facc15" stroke-width="${strokeW}" stroke-dasharray="${bufferDash}" stroke-dashoffset="${bufferOff}" stroke-linecap="round" opacity="0.85"/>
          <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#3b82f6" stroke-width="${strokeW}" stroke-dasharray="${coLpDash}" stroke-dashoffset="${coLpOff}" stroke-linecap="round" opacity="0.9"/>
          <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#2fe6c4" stroke-width="${strokeW}" stroke-dasharray="${freeDash}" stroke-dashoffset="${freeOff}" stroke-linecap="round" opacity="0.9"/>
        </g>
        <circle cx="${cx}" cy="${cy}" r="${r - strokeW / 2}" fill="var(--input)"/>
    </svg>`;
}

/**
 * Launch confetti - heavy rain falling from top of screen
 */
export function launchConfetti() {
    const canvas = document.createElement('canvas');
    canvas.id = 'confetti-canvas';
    document.body.appendChild(canvas);

    const ctx = canvas.getContext('2d');
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;

    const particles = [];
    const colors = ['#ff6b00', '#ff9f43', '#10b981', '#3b82f6', '#a855f7', '#ef4444', '#fbbf24'];
    const totalParticles = 350;

    function spawnParticle(delay = 0) {
        const w = canvas.width;
        const isStrip = Math.random() > 0.4;
        const size = Math.random() * 5 + 3;
        const stripRatio = isStrip ? (Math.random() > 0.5 ? 2.5 : 0.4) : 1;

        particles.push({
            x: Math.random() * (w + 200) - 100,
            y: -Math.random() * 100 - 10 - delay,
            vx: (Math.random() - 0.5) * 3,
            vy: Math.random() * 3 + 5,
            w: isStrip ? size * stripRatio : size,
            h: isStrip ? size / stripRatio : size,
            color: colors[Math.floor(Math.random() * colors.length)],
            rotation: Math.random() * 360,
            rotationSpeed: (Math.random() - 0.5) * 8,
            drag: 0.985,
            gravity: 0.18 + Math.random() * 0.12,
            opacity: 0,
            fadeIn: 0.02 + Math.random() * 0.03,
            decay: 0.004 + Math.random() * 0.006,
            maxOpacity: 0.7 + Math.random() * 0.3,
            phase: 'in'
        });
    }

    for (let i = 0; i < totalParticles; i++) {
        spawnParticle(i * 1.2);
    }

    let animationId;
    function animate() {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        let active = 0;

        for (const p of particles) {
            if (p.opacity <= 0 && p.phase === 'out') continue;
            active++;

            p.x += p.vx;
            p.y += p.vy;
            p.vy += p.gravity;
            p.vx *= p.drag;
            p.vy *= p.drag;
            p.rotation += p.rotationSpeed;

            if (p.phase === 'in') {
                p.opacity += p.fadeIn;
                if (p.opacity >= p.maxOpacity) {
                    p.opacity = p.maxOpacity;
                    p.phase = 'falling';
                }
            } else if (p.phase === 'falling') {
                p.opacity -= p.decay;
                if (p.opacity <= 0) {
                    p.opacity = 0;
                    p.phase = 'out';
                }
            }

            ctx.save();
            ctx.translate(p.x, p.y);
            ctx.rotate((p.rotation * Math.PI) / 180);
            ctx.globalAlpha = Math.max(0, p.opacity);
            ctx.fillStyle = p.color;
            ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
            ctx.restore();
        }

        if (active > 0) {
            animationId = requestAnimationFrame(animate);
        } else {
            cancelAnimationFrame(animationId);
            canvas.remove();
        }
    }

    animate();

    // Resize handler
    const onResize = () => {
        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;
    };
    window.addEventListener('resize', onResize);
    // Clean up resize listener when canvas removed
    const observer = new MutationObserver(() => {
        if (!document.body.contains(canvas)) {
            window.removeEventListener('resize', onResize);
            observer.disconnect();
        }
    });
    observer.observe(document.body, { childList: true });
}

/**
 * Get UI elements (for event handlers)
 */
export function getElements() {
    return elements;
}
