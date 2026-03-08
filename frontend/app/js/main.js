// Main Application Entry Point
// Phantom Agent - Deterministic Ephemeral Browser Wallet for XMR ⇄ wsXMR Swaps

import { 
    initializeClients, 
    connectWallet, 
    getUserAddress,
    getWsXmrBalance,
    readVaultManager,
    onAccountsChanged,
    onChainChanged
} from './viemClient.js';

import { 
    initUI,
    showWalletConnected,
    showWalletDisconnected,
    updateBalance,
    showResumeBanner,
    hideResumeBanner,
    showContractsBanner,
    hideContractsBanner,
    showMintTab,
    showBurnTab,
    populateVaults,
    showVaultInfo,
    updateMintProgress,
    completeMintStep,
    showMintDepositInfo,
    updateBurnProgress,
    completeBurnStep,
    showSuccess,
    showError,
    disableInputs,
    enableInputs,
    resetMintUI,
    resetBurnUI,
    setupCopyButtons,
    getElements
} from './ui.js';

import { MintFlow } from './mintFlow.js';
import { BurnFlow } from './burnFlow.js';
import { hasActiveSwap, loadActiveSwap, clearActiveSwap } from './storage.js';
import { CONTRACTS } from './config.js';

// Global state
let currentMintFlow = null;
let currentBurnFlow = null;

/**
 * Fetch XMR price from CoinGecko free API
 */
async function fetchXmrPrice() {
    try {
        const response = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=monero&vs_currencies=usd');
        const data = await response.json();
        
        if (data.monero && data.monero.usd) {
            const price = data.monero.usd;
            const priceElement = document.getElementById('xmr-price-stat');
            if (priceElement) {
                priceElement.textContent = `$${price.toFixed(2)}`;
            }
            console.log('✅ XMR price updated:', price);
            return price;
        }
    } catch (error) {
        console.warn('Could not fetch XMR price from CoinGecko:', error);
        const priceElement = document.getElementById('xmr-price-stat');
        if (priceElement) {
            priceElement.textContent = '$--';
        }
    }
    return null;
}

/**
 * Initialize application
 */
async function init() {
    console.log('🌉 Phantom Agent initializing...');
    
    // Initialize UI
    initUI();
    setupCopyButtons();
    
    // Initialize viem clients
    try {
        await initializeClients();
        console.log('✅ Viem clients initialized');
    } catch (error) {
        console.error('Error initializing clients:', error);
        showError('Initialization Error', error.message);
        return;
    }
    
    // Setup event handlers
    setupEventHandlers();
    
    // Check for active swap
    checkForActiveSwap();
    
    // Fetch XMR price
    fetchXmrPrice();
    
    // Update XMR price every 60 seconds
    setInterval(fetchXmrPrice, 60000);
    
    // Listen for account/chain changes
    onAccountsChanged(handleAccountChange);
    onChainChanged(handleChainChange);
    
    console.log('✅ Phantom Agent ready');
}

/**
 * Setup all event handlers
 */
function setupEventHandlers() {
    const elements = getElements();
    
    // Wallet connection
    elements.connectWallet.addEventListener('click', handleConnectWallet);
    
    // Resume swap
    elements.resumeSwap.addEventListener('click', handleResumeSwap);
    
    // Tab switching
    elements.tabMint.addEventListener('click', () => showMintTab());
    elements.tabBurn.addEventListener('click', () => showBurnTab());
    elements.tabLp.addEventListener('click', () => handleLpTab());
    
    // Mint flow
    elements.startMint.addEventListener('click', handleStartMint);
    elements.cancelMint.addEventListener('click', handleCancelMint);
    elements.mintVaultSelect.addEventListener('change', () => handleVaultSelect(true));
    
    // Burn flow
    elements.startBurn.addEventListener('click', handleStartBurn);
    elements.burnVaultSelect.addEventListener('change', () => handleVaultSelect(false));
}

/**
 * Handle wallet connection
 */
async function handleConnectWallet() {
    try {
        const address = await connectWallet();
        console.log('Wallet connected:', address);
        
        // Get user balance (with graceful fallback)
        let balance = 0n;
        try {
            balance = await getWsXmrBalance(address);
        } catch (balanceError) {
            console.warn('Could not fetch balance (contracts may not be deployed):', balanceError.message);
            // Show banner instead of modal
            showContractsBanner();
        }
        
        // Update UI
        showWalletConnected(address, balance);
        
        // Load vaults
        await loadVaults();
        
    } catch (error) {
        console.error('Error connecting wallet:', error);
        showError('Connection Error', error.message);
    }
}

/**
 * Handle account change
 */
async function handleAccountChange(newAddress) {
    if (newAddress) {
        console.log('Account changed to:', newAddress);
        let balance = 0n;
        try {
            balance = await getWsXmrBalance(newAddress);
        } catch (error) {
            console.warn('Could not fetch balance:', error.message);
        }
        showWalletConnected(newAddress, balance);
        await loadVaults();
    } else {
        console.log('Account disconnected');
        showWalletDisconnected();
    }
}

/**
 * Handle chain change
 */
function handleChainChange(chainId) {
    console.log('Chain changed to:', chainId);
    // Page will reload automatically
}

/**
 * Check for active swap on startup
 */
function checkForActiveSwap() {
    if (hasActiveSwap()) {
        const swap = loadActiveSwap();
        console.log('Active swap detected:', swap);
        showResumeBanner();
    }
}

/**
 * Handle LP tab click - check if user is an LP and show appropriate view
 */
async function handleLpTab() {
    const elements = getElements();
    
    // Hide other panels
    elements.mintPanel.classList.add('hidden');
    elements.burnPanel.classList.add('hidden');
    elements.lpPanel.classList.remove('hidden');
    
    // Update tab buttons
    elements.tabMint.classList.remove('active');
    elements.tabBurn.classList.remove('active');
    elements.tabLp.classList.add('active');
    
    // Check if user is connected
    const userAddress = getUserAddress();
    if (!userAddress) {
        // Show education view if not connected
        document.getElementById('lp-stats-view').classList.add('hidden');
        document.getElementById('lp-education-view').classList.remove('hidden');
        return;
    }
    
    // Check if user has a vault
    try {
        const vaultData = await readVaultManager('vaults', [userAddress]);
        
        // Check if vault is active
        if (vaultData && vaultData[9]) { // active is the 10th element (index 9)
            // User is an LP - show stats view
            await loadLpStats(userAddress, vaultData);
            document.getElementById('lp-education-view').classList.add('hidden');
            document.getElementById('lp-stats-view').classList.remove('hidden');
        } else {
            // User is not an LP - show education view
            document.getElementById('lp-stats-view').classList.add('hidden');
            document.getElementById('lp-education-view').classList.remove('hidden');
        }
    } catch (error) {
        console.error('Error checking LP status:', error);
        // Show education view on error
        document.getElementById('lp-stats-view').classList.add('hidden');
        document.getElementById('lp-education-view').classList.remove('hidden');
    }
}

/**
 * Load LP vault stats for the connected user
 */
async function loadLpStats(address, vaultData) {
    try {
        // Parse vault data
        // vaultData structure: [collateralAmount, normalizedDebt, pendingDebt, lockedCollateral, 
        //                       collateralAsset, mintGriefingDeposit, mintFeeBps, burnFeeBps, maxMintBps, active]
        
        const collateralAmount = vaultData[0];
        const normalizedDebt = vaultData[1];
        const mintFeeBps = vaultData[6];
        const burnFeeBps = vaultData[7];
        const maxMintBps = vaultData[8];
        
        // Update UI with vault stats
        document.getElementById('lp-collateral').textContent = `${(Number(collateralAmount) / 1e18).toFixed(2)} xDAI`;
        document.getElementById('lp-debt').textContent = `${(Number(normalizedDebt) / 1e8).toFixed(4)} wsXMR`;
        
        // Calculate health ratio (simplified - would need price data for accurate calculation)
        const collateralValue = Number(collateralAmount) / 1e18;
        const debtValue = Number(normalizedDebt) / 1e8;
        const healthRatio = debtValue > 0 ? ((collateralValue / debtValue) * 100).toFixed(0) : '∞';
        document.getElementById('lp-health').textContent = `${healthRatio}%`;
        
        // Update settings inputs
        document.getElementById('lp-mint-fee').value = Number(mintFeeBps);
        document.getElementById('lp-burn-fee').value = Number(burnFeeBps);
        document.getElementById('lp-max-mint').value = Number(maxMintBps) / 100;
        
        // TODO: Fetch fees earned from events
        document.getElementById('lp-fees').textContent = '0 xDAI';
        
        console.log('LP stats loaded for', address);
    } catch (error) {
        console.error('Error loading LP stats:', error);
    }
}

/**
 * Handle resume swap
 */
async function handleResumeSwap() {
    const swap = loadActiveSwap();
    if (!swap) {
        showError('Resume Error', 'No active swap found');
        return;
    }
    
    try {
        // Ensure wallet is connected
        const address = getUserAddress();
        if (!address) {
            await handleConnectWallet();
        }
        
        // Resume appropriate flow
        if (swap.type === 'mint') {
            currentMintFlow = new MintFlow();
            showMintTab();
            await currentMintFlow.resume(swap);
        } else if (swap.type === 'burn') {
            currentBurnFlow = new BurnFlow();
            showBurnTab();
            await currentBurnFlow.resume(swap);
        }
        
        hideResumeBanner();
        
    } catch (error) {
        console.error('Error resuming swap:', error);
        showError('Resume Error', error.message);
    }
}

/**
 * Load available LP vaults
 */
async function loadVaults() {
    try {
        // TODO: Implement vault discovery
        // For now, use a mock vault
        const mockVaults = [
            {
                address: '0x0000000000000000000000000000000000000001',
                name: 'Default LP Vault'
            }
        ];
        
        populateVaults(mockVaults);
        
    } catch (error) {
        console.error('Error loading vaults:', error);
    }
}

/**
 * Handle vault selection
 */
async function handleVaultSelect(isMint) {
    const elements = getElements();
    const vaultAddress = isMint ? 
        elements.mintVaultSelect.value : 
        elements.burnVaultSelect.value;
    
    if (!vaultAddress) return;
    
    try {
        // Fetch vault info
        const vaultData = await readVaultManager('getVault', [vaultAddress]);
        
        const vaultInfo = {
            totalXmrLocked: vaultData[0],
            totalCollateral: vaultData[1],
            collateralToken: vaultData[2],
            collateralizationRatio: vaultData[3],
            mintGriefingDeposit: vaultData[4],
            isActive: vaultData[5]
        };
        
        showVaultInfo(vaultInfo, isMint);
        
    } catch (error) {
        console.warn('Could not fetch vault info (contracts may not be deployed):', error.message);
        // Don't show error modal for this, just log it
    }
}

/**
 * Handle start mint
 */
async function handleStartMint() {
    const elements = getElements();
    
    const amount = parseFloat(elements.mintAmount.value);
    const vaultAddress = elements.mintVaultSelect.value;
    
    // Validate inputs
    if (!amount || amount <= 0) {
        showError('Invalid Input', 'Please enter a valid amount');
        return;
    }
    
    if (!vaultAddress) {
        showError('Invalid Input', 'Please select a vault');
        return;
    }
    
    try {
        disableInputs(true);
        
        // Create new mint flow
        currentMintFlow = new MintFlow();
        
        // Setup progress tracking
        trackMintProgress(currentMintFlow);
        
        // Start the flow
        await currentMintFlow.start(vaultAddress, amount);
        
        // Success
        showSuccess('Mint Complete', `Successfully minted ${amount} wsXMR!`);
        
        // Update balance
        const address = getUserAddress();
        const balance = await getWsXmrBalance(address);
        updateBalance(balance);
        
        // Reset UI
        resetMintUI();
        
    } catch (error) {
        console.error('Mint error:', error);
        showError('Mint Error', error.message);
        enableInputs(true);
    }
}

/**
 * Track mint flow progress
 */
function trackMintProgress(flow) {
    // Monitor state changes
    const checkState = setInterval(() => {
        switch (flow.state) {
            case 'init':
                updateMintProgress('init', 'Requesting signature...');
                break;
            case 'deposit':
                completeMintStep('init');
                updateMintProgress('deposit', 'Waiting for XMR deposit...');
                showMintDepositInfo(flow.agent.getMoneroAddress(), flow.xmrAmount);
                break;
            case 'evm-init':
                completeMintStep('deposit');
                updateMintProgress('evm-init', 'Submitting to blockchain...');
                break;
            case 'lp-confirm':
                completeMintStep('evm-init');
                updateMintProgress('lp-confirm', 'Waiting for LP confirmation...');
                break;
            case 'finalize':
                completeMintStep('lp-confirm');
                updateMintProgress('finalize', 'Finalizing mint...');
                break;
            case 'completed':
                completeMintStep('finalize');
                clearInterval(checkState);
                break;
        }
    }, 500);
}

/**
 * Handle cancel mint
 */
async function handleCancelMint() {
    if (!currentMintFlow) return;
    
    const confirmed = confirm('Are you sure you want to cancel this mint? Any deposited XMR will be refunded.');
    if (!confirmed) return;
    
    try {
        await currentMintFlow.cancel();
        resetMintUI();
        showSuccess('Mint Cancelled', 'Mint cancelled and XMR refunded');
    } catch (error) {
        console.error('Cancel error:', error);
        showError('Cancel Error', error.message);
    }
}

/**
 * Handle start burn
 */
async function handleStartBurn() {
    const elements = getElements();
    
    const amount = parseFloat(elements.burnAmount.value);
    const destination = elements.burnXmrDestination.value;
    const vaultAddress = elements.burnVaultSelect.value;
    
    // Validate inputs
    if (!amount || amount <= 0) {
        showError('Invalid Input', 'Please enter a valid amount');
        return;
    }
    
    if (!destination || destination.length < 95) {
        showError('Invalid Input', 'Please enter a valid Monero address');
        return;
    }
    
    if (!vaultAddress) {
        showError('Invalid Input', 'Please select a vault');
        return;
    }
    
    try {
        disableInputs(false);
        
        // Create new burn flow
        currentBurnFlow = new BurnFlow();
        
        // Setup progress tracking
        trackBurnProgress(currentBurnFlow);
        
        // Start the flow
        await currentBurnFlow.start(vaultAddress, amount, destination);
        
        // Success
        showSuccess('Burn Complete', `Successfully burned ${amount} wsXMR and sent XMR to ${destination}!`);
        
        // Update balance
        const address = getUserAddress();
        const balance = await getWsXmrBalance(address);
        updateBalance(balance);
        
        // Reset UI
        resetBurnUI();
        
    } catch (error) {
        console.error('Burn error:', error);
        showError('Burn Error', error.message);
        enableInputs(false);
    }
}

/**
 * Track burn flow progress
 */
function trackBurnProgress(flow) {
    // Monitor state changes
    const checkState = setInterval(() => {
        switch (flow.state) {
            case 'init':
                updateBurnProgress('init', 'Requesting signature...');
                break;
            case 'evm-request':
                completeBurnStep('init');
                updateBurnProgress('evm-request', 'Submitting burn request...');
                break;
            case 'lp-commit':
                completeBurnStep('evm-request');
                updateBurnProgress('lp-commit', 'Waiting for LP to lock XMR...');
                break;
            case 'claim-xmr':
                completeBurnStep('lp-commit');
                updateBurnProgress('claim-xmr', 'Claiming XMR on Monero chain...');
                break;
            case 'finalize':
                completeBurnStep('claim-xmr');
                updateBurnProgress('finalize', 'Finalizing on EVM...');
                break;
            case 'completed':
                completeBurnStep('finalize');
                clearInterval(checkState);
                break;
        }
    }, 500);
}

// Initialize app when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
