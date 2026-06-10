// UI Controller
// Manages all DOM interactions and updates

import { DECIMALS } from './config.js';
import { getIconSVG } from './icons.js';

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
    
    // Modal
    modalOverlay: null,
    modalTitle: null,
    modalBody: null,
    modalCloseBtn: null,
    
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
    elements.startBurn = document.getElementById('start-burn');
    elements.burnProgress = document.getElementById('burn-progress');
    
    // Modal
    elements.modalOverlay = document.getElementById('modal-overlay');
    elements.modalTitle = document.getElementById('modal-title');
    elements.modalBody = document.getElementById('modal-body');
    elements.modalCloseBtn = document.getElementById('modal-close-btn');
    
    // Withdraw returns
    elements.withdrawReturnsBtn = document.getElementById('withdraw-returns-btn');
    
    // Previous mint banner
    elements.previousMintBanner = document.getElementById('previous-mint-banner');
    
    // Setup modal close handlers
    const modalClose = document.querySelector('.modal-close');
    modalClose.addEventListener('click', hideModal);
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
    elements.userBalance.textContent = `${formatBalance(balance, DECIMALS.wsXMR)} wsXMR`;
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
    elements.userBalance.textContent = `${formatBalance(balance, DECIMALS.wsXMR)} wsXMR`;
    elements.burnUserBalance.textContent = formatBalance(balance, DECIMALS.wsXMR);
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
        container.style.cssText = 'display: flex; flex-direction: column; gap: 0.25rem;';

        const row = document.createElement('div');
        row.className = 'resume-swap-row';
        row.style.cssText = 'display: flex; align-items: center; justify-content: space-between; gap: 1rem; padding: 0.5rem 0.75rem; background: rgba(255,255,255,0.5); border-radius: 8px;';

        const typeLabel = swap.type === 'mint' ? 'Mint' : 'Burn';
        const amount = swap.type === 'mint'
            ? (swap.xmrAmount ? `${swap.xmrAmount.toFixed ? swap.xmrAmount.toFixed(6) : swap.xmrAmount} XMR` : 'Mint')
            : (swap.wsxmrAmount ? `${(Number(swap.wsxmrAmount) / 1e8).toFixed(4)} wsXMR` : 'Burn');
        const stateLabel = formatSwapState(swap.state);
        const vaultShort = swap.lpVault ? `${swap.lpVault.slice(0, 6)}...${swap.lpVault.slice(-4)}` : '';

        row.innerHTML = `
            <span style="font-size: 0.85rem;">
                <strong>${typeLabel}</strong> ${amount}
                <span style="color: var(--text-muted);">(${stateLabel})</span>
                ${vaultShort ? `<span style="color: var(--text-muted); font-size: 0.75rem;"> ${vaultShort}</span>` : ''}
            </span>
        `;

        // Burns are always resumable; mints need the stored publicSpendKey to regenerate the secret
        const canResume = swap.type === 'burn'
            ? true
            : (swap.publicSpendKey != null && swap.publicSpendKey !== '');
        // A mint is only truly claimable if the LP has verified it AND we still have the secret.
        // Without the secret we cannot generate the view key to verify the LP's proof.
        const isClaimableMint = swap.type === 'mint' && (swap.state === 'lp-ready' || swap.state === 'finalize') && canResume;
        const showResume = canResume || isClaimableMint;

        const btn = document.createElement('button');
        btn.className = 'btn btn-small';
        if (isClaimableMint) {
            btn.textContent = 'Claim wsXMR';
            btn.style.cssText = 'padding: 0.25rem 0.75rem; font-size: 0.8rem; background: var(--success-color); color: white; border: 1px solid var(--success-color);';
        } else if (showResume) {
            btn.textContent = 'Resume';
            btn.style.cssText = 'padding: 0.25rem 0.75rem; font-size: 0.8rem;';
        } else {
            btn.textContent = 'Resolve';
            btn.style.cssText = 'padding: 0.25rem 0.75rem; font-size: 0.8rem; background: transparent; color: var(--text-secondary); border: 1px solid var(--border-color);';
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
    errDiv.style.cssText = 'font-size: 0.8rem; color: var(--error-color); padding: 0.25rem 0.75rem; background: rgba(255,0,0,0.05); border-radius: 6px;';
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
    succDiv.style.cssText = 'font-size: 0.8rem; color: var(--success-color); padding: 0.25rem 0.75rem; background: rgba(0,255,0,0.05); border-radius: 6px;';
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
 * Populate vault select dropdown
 */
export function populateVaults(vaults) {
    const mintOptions = vaults.map(v => 
        `<option value="${v.address}">${v.name || formatAddress(v.address)}</option>`
    ).join('');
    
    const burnOptions = mintOptions;
    
    elements.mintVaultSelect.innerHTML = mintOptions;
    elements.burnVaultSelect.innerHTML = burnOptions;
    
    // Also populate Co-LP vault select
    const coLpVaultSelect = document.getElementById('co-lp-vault-select');
    if (coLpVaultSelect) {
        coLpVaultSelect.innerHTML = mintOptions;
    }
    
    // Also populate the Active LP Vaults display
    const vaultsList = document.getElementById('vaults-list');
    if (vaultsList) {
        if (vaults.length === 0) {
            vaultsList.innerHTML = '<div class="no-data">No active LP vaults found</div>';
        } else {
            const vaultsHtml = vaults.map(v => {
                const shortAddr = `${v.address.slice(0, 6)}...${v.address.slice(-4)}`;
                const collateralAmount = v.collateral ? formatBalance(v.collateral, 18) : '0';
                const usedRaw = v.usedCollateral !== undefined ? v.usedCollateral : 0;
                const pendingRaw = v.pendingCollateral !== undefined ? v.pendingCollateral : 0;
                const bufferRaw = v.bufferCollateral !== undefined ? v.bufferCollateral : 0;
                const freeRaw = v.freeCollateral !== undefined ? v.freeCollateral : (v.collateral ? Number(v.collateral) / 1e18 : 0);
                const usedAmount = fmtCapacity(usedRaw);
                const pendingAmount = fmtCapacity(pendingRaw);
                const bufferAmount = fmtCapacity(bufferRaw);
                const freeAmount = fmtCapacity(freeRaw);
                const totalCap = usedRaw + pendingRaw + bufferRaw + freeRaw;
                const usedPct = totalCap > 0 ? (usedRaw / totalCap) * 100 : 0;
                const pendingPct = totalCap > 0 ? (pendingRaw / totalCap) * 100 : 0;
                const bufferPct = totalCap > 0 ? (bufferRaw / totalCap) * 100 : 0;
                const freePct = totalCap > 0 ? (freeRaw / totalCap) * 100 : 0;
                const pieSvg = totalCap > 0 ? makePieChart(usedPct, pendingPct, bufferPct, freePct) : '';
                console.log('Vault chart:', { usedRaw, pendingRaw, bufferRaw, freeRaw, usedPct, pendingPct, bufferPct, freePct, pieSvg: pieSvg.slice(0, 80) });

                return `
                <div class="vault-item">
                    <div class="vault-header">
                        <strong>LP Vault ${shortAddr}</strong>
                        <span class="vault-collateral">${collateralAmount} sDAI</span>
                        <a href="https://gnosisscan.io/address/${v.address}" target="_blank" rel="noopener" class="vault-scan-inline" title="View on GnosisScan">${getIconSVG('externalLink')}</a>
                    </div>
                    ${v.collateral ? `<div class="vault-chart-row">
                        ${pieSvg}
                        <div class="vault-legend">
                            <div class="legend-row">
                                <span class="legend-dot used-dot"></span>
                                <div class="legend-text">
                                    <span class="legend-label">Backing debt:</span>
                                    <span class="legend-value">${usedAmount} sDAI</span>
                                </div>
                            </div>
                            ${pendingRaw > 0 ? `<div class="legend-row">
                                <span class="legend-dot pending-dot"></span>
                                <div class="legend-text">
                                    <span class="legend-label">Pending debt:</span>
                                    <span class="legend-value">${pendingAmount} sDAI</span>
                                </div>
                            </div>` : ''}
                            <div class="legend-row">
                                <span class="legend-dot buffer-dot"></span>
                                <div class="legend-text">
                                    <span class="legend-label">Safety buffer:</span>
                                    <span class="legend-value">${bufferAmount} sDAI</span>
                                </div>
                            </div>
                            <div class="legend-row">
                                <span class="legend-dot free-dot"></span>
                                <div class="legend-text">
                                    <span class="legend-label">Free capacity:</span>
                                    <span class="legend-value">${freeAmount} sDAI</span>
                                </div>
                            </div>
                        </div>
                    </div>` : ''}
                </div>
            `;
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
 * Update mint progress
 */
export function updateMintProgress(step, status = null) {
    const steps = elements.mintProgress.querySelectorAll('.progress-step');

    steps.forEach(stepEl => {
        const stepName = stepEl.getAttribute('data-step');

        if (stepName === step) {
            stepEl.classList.add('active');
            stepEl.classList.remove('completed');
            // Ensure body is measured for smooth animation
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
            stepEl.classList.remove('active');
        }
    });

    elements.mintProgress.classList.remove('hidden');
}

/**
 * Mark mint step as completed
 */
export function completeMintStep(step) {
    const stepEl = elements.mintProgress.querySelector(`[data-step="${step}"]`);
    if (stepEl) {
        stepEl.classList.add('completed');
        stepEl.classList.remove('active');
        // Collapse status to a compact done message
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
export function showMintDepositInfo(address, amount) {
    // If address is still placeholder, show loading message
    if (address === 'LP_WILL_PROVIDE_ADDRESS') {
        elements.mintXmrAddress.textContent = 'Fetching deposit address from LP node...';
    } else {
        elements.mintXmrAddress.textContent = address;
    }
    elements.mintExactAmount.textContent = amount.toFixed(8);
    
    // Generate QR code
    generateQRCode(elements.mintQrCode, `monero:${address}?tx_amount=${amount}`);
    
    // Show button, hide verification status initially
    if (elements.confirmSentXmr) {
        elements.confirmSentXmr.classList.remove('hidden');
    }
    if (elements.waitingLpVerification) {
        elements.waitingLpVerification.classList.add('hidden');
    }

    elements.mintDepositInfo.classList.remove('hidden');
    elements.mintActions.classList.remove('hidden');
}

/**
 * Show LP verification status (after user confirms they sent XMR)
 */
export function showLPVerificationStatus() {
    if (elements.confirmSentXmr) {
        elements.confirmSentXmr.classList.add('hidden');
    }
    
    // Hide deposit info by default - user can click "See TX Details" to view it
    if (elements.mintDepositInfo) {
        elements.mintDepositInfo.classList.add('hidden');
    }
    
    // Keep deposit step body expanded so the verification status and toggle button are visible
    const depositStep = elements.mintProgress?.querySelector('[data-step="deposit"]');
    if (depositStep) {
        const body = depositStep.querySelector('.step-body');
        if (body) body.classList.add('force-open');
    }

    if (elements.waitingLpVerification) {
        elements.waitingLpVerification.classList.remove('hidden');
        elements.waitingLpVerification.innerHTML = `
            <svg class="spin" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="display:inline-block;vertical-align:middle;margin-right:6px;color:var(--accent-orange);"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg> 
            Waiting for LP to verify your transaction...
            <br>
            <span style="font-size:0.8rem;color:var(--text-muted);margin-left:20px;display:block;margin-top:4px;">
                The LP waits for 10+ Monero blockchain confirmations before marking your deposit as verified (~15–30 min).
            </span>
            <button id="show-tx-details-btn" class="btn btn-secondary" style="margin-top:12px;margin-left:20px;font-size:0.85rem;padding:6px 12px;">
                ${getIconSVG('eye')} See TX Details
            </button>
        `;
        
        // Add click handler for the button
        const showTxDetailsBtn = document.getElementById('show-tx-details-btn');
        if (showTxDetailsBtn && elements.mintDepositInfo) {
            showTxDetailsBtn.onclick = () => {
                const isHidden = elements.mintDepositInfo.classList.contains('hidden');
                if (isHidden) {
                    elements.mintDepositInfo.classList.remove('hidden');
                    showTxDetailsBtn.innerHTML = `${getIconSVG('eye-off')} Hide TX Details`;
                } else {
                    elements.mintDepositInfo.classList.add('hidden');
                    showTxDetailsBtn.innerHTML = `${getIconSVG('eye')} See TX Details`;
                }
            };
        }
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
    
    // Create or show claim button
    let claimButton = elements.mintActions.querySelector('.claim-wsxmr-btn');
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
        elements.mintActions.appendChild(claimButton);
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
    const steps = elements.burnProgress.querySelectorAll('.progress-step');

    steps.forEach(stepEl => {
        const stepName = stepEl.getAttribute('data-step');

        if (stepName === step) {
            stepEl.classList.add('active');
            stepEl.classList.remove('completed');
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
            stepEl.classList.remove('active');
        }
    });

    elements.burnProgress.classList.remove('hidden');
}

/**
 * Mark burn step as completed
 */
export function completeBurnStep(step) {
    const stepEl = elements.burnProgress.querySelector(`[data-step="${step}"]`);
    if (stepEl) {
        stepEl.classList.add('completed');
        stepEl.classList.remove('active');
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
 * Show modal
 */
export function showModal(title, body, isError = false) {
    elements.modalTitle.textContent = title;
    elements.modalBody.innerHTML = body;
    elements.modalOverlay.classList.remove('hidden');
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

    launchConfetti();
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
}

/**
 * Show error modal
 */
export function showError(title, message) {
    showModal(title, `<p style="color: var(--error-color);">${message}</p>`, true);
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
    } else {
        elements.burnAmount.disabled = true;
        elements.burnXmrDestination.disabled = true;
        elements.burnVaultSelect.disabled = true;
        elements.startBurn.disabled = true;
    }
}

/**
 * Enable form inputs
 */
export function enableInputs(isMint = true) {
    if (isMint) {
        elements.mintAmount.disabled = false;
        elements.mintVaultSelect.disabled = false;
    } else {
        elements.burnAmount.disabled = false;
        elements.burnXmrDestination.disabled = false;
        elements.burnVaultSelect.disabled = false;
        elements.startBurn.disabled = false;
    }
}

/**
 * Reset mint UI
 */
export function resetMintUI() {
    elements.mintProgress.classList.add('hidden');
    elements.mintDepositInfo.classList.add('hidden');
    elements.mintActions.classList.add('hidden');
    elements.previousMintBanner?.classList.add('hidden');
    enableInputs(true);
    const claimBtn = elements.mintActions?.querySelector('.claim-wsxmr-btn');
    if (claimBtn) claimBtn.remove();
    if (elements.cancelMint) elements.cancelMint.classList.remove('hidden');
    const btnText = elements.startMint?.querySelector('.btn-text');
    if (btnText) btnText.textContent = 'Start Mint';
    // Clean up any forced-open step bodies
    elements.mintProgress?.querySelectorAll('.step-body.force-open').forEach(b => b.classList.remove('force-open'));
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
 * Slices: used (orange), pending (purple), buffer (yellow), free (green)
 */
function makePieChart(usedPct, pendingPct, bufferPct, freePct) {
    const size = 64;
    const cx = size / 2;
    const cy = size / 2;
    const r = 26;
    const strokeW = 10;
    const circ = +(2 * Math.PI * r).toFixed(2);
    const minVis = 3;

    let usedLen = +(usedPct / 100 * circ).toFixed(2);
    let pendingLen = +(pendingPct / 100 * circ).toFixed(2);
    let bufferLen = +(bufferPct / 100 * circ).toFixed(2);
    let freeLen = +(freePct / 100 * circ).toFixed(2);

    // Clamp
    usedLen = Math.min(usedLen, circ);
    pendingLen = Math.min(pendingLen, circ);
    bufferLen = Math.min(bufferLen, circ);
    freeLen = Math.min(freeLen, circ);

    // Guard against NaN / Infinity
    if (!Number.isFinite(usedLen)) usedLen = 0;
    if (!Number.isFinite(pendingLen)) pendingLen = 0;
    if (!Number.isFinite(bufferLen)) bufferLen = 0;
    if (!Number.isFinite(freeLen)) freeLen = circ;

    // Build SVG — stacked circles with dash offsets
    const usedDash = `${usedLen} ${circ}`;
    const pendingDash = `${pendingLen} ${circ}`;
    const bufferDash = `${bufferLen} ${circ}`;
    const freeDash = `${freeLen} ${circ}`;
    const pendingOff = -usedLen;
    const bufferOff = -(usedLen + pendingLen);
    const freeOff = -(usedLen + pendingLen + bufferLen);

    return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" class="vault-pie">
        <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#f97316" stroke-width="${strokeW}" stroke-dasharray="${usedDash}" transform="rotate(-90 ${cx} ${cy})"/>
        <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#a855f7" stroke-width="${strokeW}" stroke-dasharray="${pendingDash}" stroke-dashoffset="${pendingOff}" transform="rotate(-90 ${cx} ${cy})"/>
        <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#eab308" stroke-width="${strokeW}" stroke-dasharray="${bufferDash}" stroke-dashoffset="${bufferOff}" transform="rotate(-90 ${cx} ${cy})"/>
        <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#10b981" stroke-width="${strokeW}" stroke-dasharray="${freeDash}" stroke-dashoffset="${freeOff}" transform="rotate(-90 ${cx} ${cy})"/>
        <circle cx="${cx}" cy="${cy}" r="${r - strokeW / 2}" fill="var(--bg-card-light)"/>
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
