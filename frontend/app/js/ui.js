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
    tabLp: null,
    
    // Panels
    mintPanel: null,
    burnPanel: null,
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
    modalCloseBtn: null
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
    elements.tabLp = document.getElementById('tab-lp');
    
    // Panels
    elements.mintPanel = document.getElementById('mint-panel');
    elements.burnPanel = document.getElementById('burn-panel');
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
 */
export function showResumeBanner(swaps, onResume) {
    if (!swaps || swaps.length === 0) {
        hideResumeBanner();
        return;
    }

    // Update title
    elements.resumeBannerTitle.textContent = swaps.length === 1
        ? 'Active swap detected!'
        : `${swaps.length} active swaps detected!`;

    // Build list
    elements.resumeSwapList.innerHTML = '';
    for (const swap of swaps) {
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

        const btn = document.createElement('button');
        btn.className = 'btn btn-small';
        btn.textContent = 'Resume';
        btn.style.cssText = 'padding: 0.25rem 0.75rem; font-size: 0.8rem;';
        btn.addEventListener('click', () => {
            if (onResume) onResume(swap);
        });
        row.appendChild(btn);

        elements.resumeSwapList.appendChild(row);
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
        'lp-confirm': 'LP Confirming',
        'finalize': 'Finalizing',
        'evm-request': 'Requesting',
        'lp-propose': 'LP Proposing',
        'committed': 'Committed',
        'completed': 'Complete'
    };
    return labels[state] || state;
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

/**
 * Switch to mint tab
 */
export function showMintTab() {
    elements.tabMint.classList.add('active');
    elements.tabBurn.classList.remove('active');
    elements.tabLp.classList.remove('active');
    elements.mintPanel.classList.remove('hidden');
    elements.burnPanel.classList.add('hidden');
    elements.lpPanel.classList.add('hidden');
}

/**
 * Switch to burn tab
 */
export async function showBurnTab() {
    elements.tabBurn.classList.add('active');
    elements.tabMint.classList.remove('active');
    elements.tabLp.classList.remove('active');
    elements.burnPanel.classList.remove('hidden');
    elements.mintPanel.classList.add('hidden');
    elements.lpPanel.classList.add('hidden');
    
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
            if (status) {
                const statusEl = stepEl.querySelector('.step-status');
                statusEl.textContent = status;
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
    if (elements.waitingLpVerification) {
        elements.waitingLpVerification.classList.remove('hidden');
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
            <span class="btn-icon">${getIconSVG('check')}</span>
            <span>Claim wsXMR</span>
        `;
        elements.mintActions.appendChild(claimButton);
    }
    
    claimButton.classList.remove('hidden');
    claimButton.onclick = onClaim;
    
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
            if (status) {
                const statusEl = stepEl.querySelector('.step-status');
                statusEl.textContent = status;
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
export function showSuccess(title, message) {
    showModal(title, `<p style="color: var(--success-color);">✅ ${message}</p>`);
}

/**
 * Show error modal
 */
export function showError(title, message) {
    showModal(title, `<p style="color: var(--error-color);">❌ ${message}</p>`, true);
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
                    btn.textContent = '✅';
                    setTimeout(() => {
                        btn.textContent = '📋';
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
        elements.startMint.disabled = true;
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
        elements.startMint.disabled = false;
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
    enableInputs(true);
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
 * Get UI elements (for event handlers)
 */
export function getElements() {
    return elements;
}
