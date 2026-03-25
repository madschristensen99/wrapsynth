// UI Controller
// Manages all DOM interactions and updates

import { DECIMALS } from './config.js';

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
    resumeSwap: null,
    
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
    elements.resumeSwap = document.getElementById('resume-swap');
    
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
    elements.mainInterface.classList.remove('hidden');
}

/**
 * Show wallet disconnected state
 */
export function showWalletDisconnected() {
    elements.connectWallet.classList.remove('hidden');
    elements.connectedInfo.classList.add('hidden');
    elements.mainInterface.classList.add('hidden');
}

/**
 * Update user balance display
 */
export function updateBalance(balance) {
    elements.userBalance.textContent = `${formatBalance(balance, DECIMALS.wsXMR)} wsXMR`;
    elements.burnUserBalance.textContent = formatBalance(balance, DECIMALS.wsXMR);
}

/**
 * Show resume banner
 */
export function showResumeBanner() {
    elements.resumeBanner.classList.remove('hidden');
}

/**
 * Hide resume banner
 */
export function hideResumeBanner() {
    elements.resumeBanner.classList.add('hidden');
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
export function showBurnTab() {
    elements.tabBurn.classList.add('active');
    elements.tabMint.classList.remove('active');
    elements.tabLp.classList.remove('active');
    elements.burnPanel.classList.remove('hidden');
    elements.mintPanel.classList.add('hidden');
    elements.lpPanel.classList.add('hidden');
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
                const debtAmount = v.debt ? formatBalance(v.debt, 8) : '0';
                
                return `
                <div class="vault-item">
                    <div class="vault-header">
                        <strong>LP Vault ${shortAddr}</strong>
                        <span class="vault-collateral">${collateralAmount} sDAI</span>
                    </div>
                    ${v.collateral ? `<div class="vault-stats">
                        <span>💰 Collateral: ${collateralAmount} sDAI</span>
                        <span>📊 Debt: ${debtAmount} wsXMR</span>
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
    
    elements.mintDepositInfo.classList.remove('hidden');
    elements.mintActions.classList.remove('hidden');
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
 * Using a simple QR code library via CDN
 */
function generateQRCode(canvas, data) {
    // Simple QR code generation
    // In production, use a library like qrcode.js
    const ctx = canvas.getContext('2d');
    canvas.width = 200;
    canvas.height = 200;
    
    // For now, just show placeholder
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, 200, 200);
    ctx.fillStyle = '#000000';
    ctx.font = '12px monospace';
    ctx.fillText('QR Code', 70, 100);
    ctx.fillText('(Placeholder)', 55, 115);
    
    // TODO: Integrate actual QR code library
    // Example: QRCode.toCanvas(canvas, data, { width: 200 });
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
 * Get UI elements (for event handlers)
 */
export function getElements() {
    return elements;
}
