// Main Application Entry Point
// Phantom Agent - Deterministic Ephemeral Browser Wallet for XMR ⇄ wsXMR Swaps

import { 
    initializeClients, 
    connectWallet, 
    getUserAddress,
    getWsXmrBalance,
    readHub,
    writeHub,
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
    showCoLPTab,
    populateVaults,
    showVaultInfo,
    updateMintProgress,
    completeMintStep,
    showMintDepositInfo,
    updateBurnProgress,
    completeBurnStep,
    showSuccess,
    showError,
    showResumeError,
    disableInputs,
    enableInputs,
    resetMintUI,
    resetBurnUI,
    setupCopyButtons,
    getElements,
    setWithdrawReturnsVisible
} from './ui.js';

import { MintFlow } from './mintFlow.js';
import { BurnFlow } from './burnFlow.js';
import { getLPPanel } from './lpPanel.js';
import { getPoolFlow } from './poolFlow.js';
import { getCoLPFlow } from './coLPFlow.js';
import { getDashboard } from './dashboard.js';
import { hasActiveSwap, loadActiveSwap, loadActiveSwaps, saveActiveSwap, addOrUpdateActiveSwap, removeActiveSwap, clearActiveSwap, setSwapsArray, getActiveSwapByRequestId } from './storage.js';
import { CONTRACTS } from './config.js';
import { displaySwapHistory } from './swapHistory.js';
import { loadRecentActivity, startActivityFeedWatcher } from './activityFeed.js';
import { updateProtocolStats } from './protocolStats.js';

// Global state
let currentMintFlow = null;
let currentBurnFlow = null;

/**
 * Fetch XMR price from CoinGecko free API
 */
async function fetchXmrPrice() {
    try {
        console.log('Fetching XMR price from CoinGecko...');
        const response = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=monero&vs_currencies=usd');
        
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        const data = await response.json();
        console.log('CoinGecko response:', data);
        
        if (data.monero && data.monero.usd) {
            const price = data.monero.usd;
            const priceElement = document.getElementById('xmr-price-stat');
            if (priceElement) {
                priceElement.textContent = `$${price.toFixed(2)}`;
                console.log('[SUCCESS] XMR price updated:', price);
            } else {
                console.error('Price element not found!');
            }
            return price;
        } else {
            console.error('Invalid data structure from CoinGecko:', data);
        }
    } catch (error) {
        console.error('Could not fetch XMR price from CoinGecko:', error);
        const priceElement = document.getElementById('xmr-price-stat');
        if (priceElement) {
            priceElement.textContent = '$--';
        }
    }
    return null;
}

/**
 * Fetch 24h volume from mint/burn events
 */
async function fetch24hVolume() {
    try {
        const { getPublicClient } = await import('./viemClient.js');
        const { CONTRACTS } = await import('./config.js');
        const { parseAbi } = await import('https://esm.sh/viem@2.7.0');
        
        const publicClient = getPublicClient();
        const currentBlock = await publicClient.getBlockNumber();
        const blocksPerDay = 17280n; // ~5 second blocks on Gnosis
        const fromBlock = currentBlock - blocksPerDay;
        
        const hubAbi = parseAbi([
            'event MintInitiated(bytes32 indexed requestId, address indexed initiator, address indexed recipient, address lpVault, uint256 xmrAmount, uint256 wsxmrAmount, uint256 feeAmount, bytes32 claimCommitment, uint256 timeout)',
            'event BurnRequested(bytes32 indexed requestId, address indexed user, address indexed lpVault, uint256 wsxmrAmount, uint256 xmrAmount, uint256 rewardCollateral)'
        ]);
        
        const [mintEvents, burnEvents] = await Promise.all([
            publicClient.getContractEvents({
                address: CONTRACTS.hub,
                abi: hubAbi,
                eventName: 'MintInitiated',
                fromBlock,
                toBlock: 'latest'
            }),
            publicClient.getContractEvents({
                address: CONTRACTS.hub,
                abi: hubAbi,
                eventName: 'BurnRequested',
                fromBlock,
                toBlock: 'latest'
            })
        ]);
        
        // Sum up wsXMR amounts from both mints and burns
        let totalWsxmr = 0n;
        for (const event of mintEvents) {
            totalWsxmr += event.args.wsxmrAmount;
        }
        for (const event of burnEvents) {
            totalWsxmr += event.args.wsxmrAmount;
        }
        
        // Convert to float (8 decimals)
        const wsxmrVolume = Number(totalWsxmr) / 1e8;
        
        // Get XMR price
        const xmrPrice = await fetchXmrPrice();
        const volumeUsd = wsxmrVolume * (xmrPrice || 0);
        
        const volumeElement = document.getElementById('volume-stat');
        if (volumeElement) {
            if (volumeUsd >= 1000) {
                volumeElement.textContent = `$${(volumeUsd / 1000).toFixed(1)}K`;
            } else if (volumeUsd >= 1) {
                volumeElement.textContent = `$${volumeUsd.toFixed(0)}`;
            } else if (volumeUsd > 0) {
                volumeElement.textContent = `$${volumeUsd.toFixed(2)}`;
            } else {
                volumeElement.textContent = '$0';
            }
        }
        
        console.log(`24h volume: ${wsxmrVolume.toFixed(2)} wsXMR ($${volumeUsd.toFixed(2)})`);
    } catch (error) {
        console.error('Could not fetch 24h volume:', error);
        const volumeElement = document.getElementById('volume-stat');
        if (volumeElement) {
            volumeElement.textContent = '$0';
        }
    }
}

/**
 * Initialize application
 */
async function init() {
    console.log('[INIT] Phantom Agent initializing...');
    
    // Initialize UI
    initUI();
    
    // Display swap history
    displaySwapHistory();
    setupCopyButtons();
    
    // Initialize viem clients
    try {
        await initializeClients();
        console.log('[SUCCESS] Viem clients initialized');
    } catch (error) {
        console.error('Error initializing clients:', error);
        showError('Initialization Error', error.message);
        return;
    }
    
    // Setup event handlers
    setupEventHandlers();
    
    // Load vaults (don't require wallet connection)
    await loadVaults();
    
    // Check for active swap
    checkForActiveSwap();
    
    // Fetch XMR price and 24h volume
    fetchXmrPrice();
    fetch24hVolume();
    
    // Load activity feed and protocol stats
    loadRecentActivity();
    startActivityFeedWatcher();
    updateProtocolStats();
    
    // Update stats every 60 seconds
    setInterval(() => {
        fetchXmrPrice();
        fetch24hVolume();
        loadRecentActivity();
        updateProtocolStats();
    }, 60000);
    
    // Listen for account/chain changes
    onAccountsChanged(handleAccountChange);
    onChainChanged(handleChainChange);
    
    console.log('[SUCCESS] Phantom Agent ready');
}

/**
 * Setup all event handlers
 */
function setupEventHandlers() {
    const elements = getElements();
    
    // Wallet connection
    elements.connectWallet.addEventListener('click', handleConnectWallet);
    if (elements.withdrawReturnsBtn) {
        elements.withdrawReturnsBtn.addEventListener('click', handleWithdrawReturns);
    }
    
    // Tab switching
    elements.tabMint.addEventListener('click', () => showMintTab());
    elements.tabBurn.addEventListener('click', () => showBurnTab());
    elements.tabCoLP.addEventListener('click', () => handleCoLPTab());
    elements.tabLp.addEventListener('click', () => handleLpTab());
    
    // Mint flow
    elements.startMint.addEventListener('click', handleStartMint);
    elements.cancelMint.addEventListener('click', handleCancelMint);
    elements.mintVaultSelect.addEventListener('change', () => handleVaultSelect(true));
    
    // Burn flow
    elements.startBurn.addEventListener('click', handleStartBurn);
    elements.burnVaultSelect.addEventListener('change', () => handleVaultSelect(false));
    
    // Co-LP handlers
    const coLpVaultSelect = document.getElementById('co-lp-vault-select');
    if (coLpVaultSelect) {
        coLpVaultSelect.addEventListener('change', handleCoLPVaultSelect);
    }
    const coLpOpenBtn = document.getElementById('co-lp-open');
    if (coLpOpenBtn) {
        coLpOpenBtn.addEventListener('click', handleCoLPOpen);
    }
    const coLpUnwindBtn = document.getElementById('co-lp-unwind');
    if (coLpUnwindBtn) {
        coLpUnwindBtn.addEventListener('click', handleCoLPUnwind);
    }
    const coLpRebalanceBtn = document.getElementById('co-lp-rebalance');
    if (coLpRebalanceBtn) {
        coLpRebalanceBtn.addEventListener('click', handleCoLPRebalance);
    }
    const coLpSetRangeBtn = document.getElementById('co-lp-set-range');
    if (coLpSetRangeBtn) {
        coLpSetRangeBtn.addEventListener('click', handleCoLPSetRange);
    }
    const coLpRefreshBtn = document.getElementById('co-lp-refresh-positions');
    if (coLpRefreshBtn) {
        coLpRefreshBtn.addEventListener('click', handleRefreshCoLPPositions);
    }

    // Burn percentage buttons
    document.querySelectorAll('.percentage-btn').forEach(btn => {
        btn.addEventListener('click', handleBurnPercentage);
    });
    
    // Manual price update button
    const updatePricesBtn = document.getElementById('update-prices-btn');
    if (updatePricesBtn) {
        updatePricesBtn.addEventListener('click', handleUpdatePrices);
    }
}

/**
 * Handle burn percentage button clicks
 */
async function handleBurnPercentage(event) {
    const percentage = parseInt(event.target.dataset.percentage);
    const feedback = document.getElementById('burn-percentage-feedback');
    
    // Get actual balance from contract
    const { readWsxmr, getUserAddress } = await import('./viemClient.js');
    const userAddress = getUserAddress();
    
    if (!userAddress) {
        feedback.textContent = 'Connect wallet first';
        feedback.style.opacity = '1';
        setTimeout(() => { feedback.style.opacity = '0'; }, 2000);
        return;
    }
    
    try {
        const balance = await readWsxmr('balanceOf', [userAddress]);
        const balanceNum = Number(balance) / 1e8; // wsXMR has 8 decimals
        
        if (balanceNum === 0) {
            feedback.textContent = 'No balance';
            feedback.style.opacity = '1';
            setTimeout(() => { feedback.style.opacity = '0'; }, 2000);
            return;
        }
        
        const amount = (balanceNum * percentage) / 100;
        const burnAmountInput = document.getElementById('burn-amount');
        burnAmountInput.value = amount.toFixed(8);
        
        feedback.textContent = `✓ ${percentage}%`;
        feedback.style.opacity = '1';
        setTimeout(() => { feedback.style.opacity = '0'; }, 1500);
    } catch (error) {
        console.error('Failed to get balance:', error);
        feedback.textContent = 'Error';
        feedback.style.opacity = '1';
        setTimeout(() => { feedback.style.opacity = '0'; }, 2000);
    }
}

/**
 * Handle manual price update
 */
async function handleUpdatePrices() {
    const btn = document.getElementById('update-prices-btn');
    const originalText = btn.innerHTML;
    
    try {
        // Disable button and show loading state
        btn.disabled = true;
        btn.innerHTML = '<span class="btn-icon"><svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="spin"><path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2"/></svg></span><span>Updating...</span>';
        
        console.log('Manually updating oracle prices...');
        
        // Import and call the update function
        const { updateOraclePrices } = await import('./redstoneWrapper.js?v=' + Date.now());
        await updateOraclePrices();
        
        // Success feedback
        btn.innerHTML = '<span class="btn-icon">✅</span><span>Updated!</span>';
        setTimeout(() => {
            btn.innerHTML = originalText;
            btn.disabled = false;
        }, 2000);
        
        console.log('✅ Oracle prices updated successfully');
        showSuccess('Prices Updated', 'Oracle prices have been updated with latest RedStone data.');
        
    } catch (error) {
        console.error('Failed to update prices:', error);
        btn.innerHTML = '<span class="btn-icon">❌</span><span>Failed</span>';
        setTimeout(() => {
            btn.innerHTML = originalText;
            btn.disabled = false;
        }, 2000);
        
        showError('Update Failed', `Could not update oracle prices: ${error.message}`);
    }
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
        
        // Check for active swaps on chain
        await checkForActiveSwapOnChain(address);
        
        // Auto-resume most recent swap, but keep banner visible for all
        const allSwaps = loadActiveSwaps();
        if (allSwaps.length > 0) {
            const mostRecent = allSwaps[allSwaps.length - 1];
            autoResumeSwap(mostRecent);
        }
        
    } catch (error) {
        console.error('Error connecting wallet:', error);
        showError('Connection Error', error.message);
    }
}

/**
 * Auto-resume a specific swap without hiding the banner
 */
function autoResumeSwap(swap) {
    if (!swap) return;

    // Don't auto-resume swaps that can't be resumed (no stored secret)
    if (!swap.publicSpendKey) {
        console.log('Skipping auto-resume: swap has no publicSpendKey');
        return;
    }

    if (swap.type === 'mint') {
        showMintTab();
        currentMintFlow = new MintFlow();
        trackMintProgress(currentMintFlow);
        currentMintFlow.resume(swap).catch(err => {
            console.error('Auto-resume mint error:', err);
            showResumeError(swap.requestId, err.message || 'Could not resume your mint. Please clear the swap and start fresh.');
        });
    } else if (swap.type === 'burn') {
        showBurnTab();
        currentBurnFlow = new BurnFlow();
        trackBurnProgress(currentBurnFlow);
        currentBurnFlow.resume(swap).catch(err => {
            console.error('Auto-resume burn error:', err);
            showResumeError(swap.requestId, err.message || 'Could not resume your burn. Please clear the swap and start fresh.');
        });
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
        await checkForActiveSwapOnChain(newAddress);
        await checkPendingReturns(newAddress);
        
        // Auto-resume most recent swap, but keep banner visible for all
        const allSwaps = loadActiveSwaps();
        if (allSwaps.length > 0) {
            const mostRecent = allSwaps[allSwaps.length - 1];
            autoResumeSwap(mostRecent);
        }
    } else {
        console.log('Account disconnected');
        showWalletDisconnected();
        setWithdrawReturnsVisible(false);
    }
}

/**
 * Check if user has pending returns and show/hide button
 */
async function checkPendingReturns(address) {
    try {
        const ethReturns = await readHub('getPendingReturns', [address, '0x0000000000000000000000000000000000000000']);
        const sDAIReturns = await readHub('getPendingReturns', [address, CONTRACTS.sDAI]);
        setWithdrawReturnsVisible(ethReturns > 0n || sDAIReturns > 0n);
    } catch (error) {
        console.warn('Could not check pending returns:', error.message);
        setWithdrawReturnsVisible(false);
    }
}

/**
 * Handle withdraw returns button click
 */
async function handleWithdrawReturns() {
    const address = getUserAddress();
    if (!address) return;
    
    try {
        const ethReturns = await readHub('getPendingReturns', [address, '0x0000000000000000000000000000000000000000']);
        const sDAIReturns = await readHub('getPendingReturns', [address, CONTRACTS.sDAI]);
        
        const txs = [];
        
        if (ethReturns > 0n) {
            const receipt = await writeHub('withdrawReturns', ['0x0000000000000000000000000000000000000000']);
            txs.push(receipt.transactionHash);
        }
        
        if (sDAIReturns > 0n) {
            const receipt = await writeHub('withdrawReturns', [CONTRACTS.sDAI]);
            txs.push(receipt.transactionHash);
        }
        
        if (txs.length > 0) {
            showSuccess('Returns Withdrawn', `Withdrew from ${txs.length} token(s).`);
            setWithdrawReturnsVisible(false);
        } else {
            showError('No Returns', 'You have no pending returns to withdraw.');
        }
    } catch (error) {
        console.error('Error withdrawing returns:', error);
        showError('Withdraw Failed', error.message || 'Could not withdraw returns.');
    }
}

/**
 * Handle chain change
 */
async function handleChainChange(chainId) {
    console.log('Chain changed to:', chainId);
    
    // Reinitialize clients with new chain
    try {
        await initializeClients();
        
        // If user was connected, reconnect
        const currentAddress = getUserAddress();
        if (currentAddress) {
            const address = await connectWallet();
            let balance = 0n;
            try {
                balance = await getWsXmrBalance(address);
            } catch (error) {
                console.warn('Could not fetch balance:', error.message);
            }
            showWalletConnected(address, balance);
            await loadVaults();
        }
    } catch (error) {
        console.error('Error handling chain change:', error);
        showError('Network Error', 'Failed to switch network. Please try reconnecting your wallet.');
    }
}

/**
 * Check for active swap on startup (localStorage only)
 */
async function checkForActiveSwap() {
    const swaps = loadActiveSwaps();
    if (swaps.length === 0) return;
    
    console.log('Found saved swaps in localStorage:', swaps);
    
    // Show banner for all swaps - on-chain check will happen when wallet connects
    showResumeBanner(swaps, handleResumeSwap, handleResolveSwap);
}

/**
 * Check for active swaps on-chain and sync to localStorage
 */
async function checkForActiveSwapOnChain(userAddress) {
    console.log('========================================');
    console.log('>>> checkForActiveSwapOnChain CALLED');
    console.log('>>> userAddress:', userAddress);
    console.log('========================================');

    if (!userAddress) {
        console.log('>>> ABORT: no userAddress');
        return;
    }

    console.log('[CHAIN CHECK] Checking for active swaps on chain for', userAddress);

    const foundSwaps = [];
    const activeRequestIds = new Set();

    try {
        // ─── Active Mints ────────────────────────────────────────────────────
        console.log('[CHAIN CHECK] Calling getUserMintRequests for', userAddress);
        let mintRequestIds;
        try {
            mintRequestIds = await readHub('getUserMintRequests', [userAddress]);
            console.log('[CHAIN CHECK] getUserMintRequests returned', mintRequestIds?.length || 0, 'request(s):', mintRequestIds);
        } catch (err) {
            console.error('[CHAIN CHECK] getUserMintRequests FAILED:', err.message);
            mintRequestIds = [];
        }

        for (const requestId of mintRequestIds) {
            let mintReq;
            try {
                mintReq = await readHub('getMintRequest', [requestId]);
            } catch (err) {
                console.error('[CHAIN CHECK] getMintRequest FAILED for', requestId, ':', err.message);
                continue;
            }

            // Status: 0=INVALID, 1=PENDING, 2=KEY_PROVIDED, 3=READY, 4=COMPLETED, 5=CANCELLED
            if (mintReq.status === 1 || mintReq.status === 2 || mintReq.status === 3) {
                activeRequestIds.add(requestId);

                let lpPublicKey = '0x0000000000000000000000000000000000000000000000000000000000000000';
                try {
                    lpPublicKey = await readHub('lpPublicKeys', [requestId]);
                } catch (err) {
                    console.warn('[CHAIN CHECK] lpPublicKeys query failed:', err.message);
                }
                const hasLpKey = lpPublicKey !== '0x0000000000000000000000000000000000000000000000000000000000000000';

                let state;
                if (mintReq.status === 3) state = 'lp-ready';  // READY - can finalize
                else if (mintReq.status === 2) state = 'lp-verifying';  // KEY_PROVIDED - LP is verifying
                else if (hasLpKey) state = 'deposit';  // PENDING with LP key - waiting for XMR
                else state = 'awaiting-lp-key';  // PENDING without LP key

                const xmrAmount = Number(mintReq.xmrAmount) / 1e12;
                let swap = {
                    type: 'mint',
                    state,
                    requestId,
                    lpVault: mintReq.lpVault,
                    xmrAmount,
                    wsxmrAmount: mintReq.wsxmrAmount.toString(),
                    griefingDeposit: mintReq.griefingDeposit.toString(),
                    lastUpdated: Date.now()
                };
                // Preserve local-only fields (e.g. publicSpendKey) from existing entry
                const existing = getActiveSwapByRequestId(requestId);
                if (existing) {
                    swap = { ...existing, ...swap };
                }
                addOrUpdateActiveSwap(swap);
                foundSwaps.push(swap);
                console.log('[CHAIN CHECK] Active mint found:', { requestId, state, xmrAmount });
            }
        }

        // ─── Active Burns ──────────────────────────────────────────────────────
        console.log('[CHAIN CHECK] Calling getUserBurnRequests for', userAddress);
        let burnRequestIds;
        try {
            burnRequestIds = await readHub('getUserBurnRequests', [userAddress]);
            console.log('[CHAIN CHECK] getUserBurnRequests returned', burnRequestIds?.length || 0, 'request(s)');
        } catch (err) {
            console.error('[CHAIN CHECK] getUserBurnRequests FAILED:', err.message);
            burnRequestIds = [];
        }

        for (const requestId of burnRequestIds) {
            let burnReq;
            try {
                burnReq = await readHub('getBurnRequest', [requestId]);
            } catch (err) {
                console.error('[CHAIN CHECK] getBurnRequest FAILED for', requestId, ':', err.message);
                continue;
            }

            // BurnStatus: 0=INVALID, 1=REQUESTED, 2=PROPOSED, 3=COMMITTED, 4=FINALIZED, 5=CANCELLED, 6=SLASHED
            if (burnReq.status === 1 || burnReq.status === 2 || burnReq.status === 3) {
                activeRequestIds.add(requestId);
                let state;
                if (burnReq.status === 3) state = 'committed';
                else if (burnReq.status === 2) state = 'lp-propose';
                else state = 'evm-request';

                const xmrAmount = Number(burnReq.xmrAmount) / 1e12;
                let swap = {
                    type: 'burn',
                    state,
                    requestId,
                    lpVault: burnReq.lpVault,
                    wsxmrAmount: burnReq.wsxmrAmount.toString(),
                    xmrAmount,
                    lastUpdated: Date.now()
                };
                // Preserve local-only fields from existing entry
                const existing = getActiveSwapByRequestId(requestId);
                if (existing) {
                    swap = { ...existing, ...swap };
                }
                addOrUpdateActiveSwap(swap);
                foundSwaps.push(swap);
                console.log('[CHAIN CHECK] Active burn found:', { requestId, state, xmrAmount });
            }
        }

        // ─── Prune stale localStorage entries ────────────────────────────────
        const allSwaps = loadActiveSwaps();
        const seen = new Map();
        for (const swap of allSwaps) {
            if (!swap.requestId) continue;
            if (!activeRequestIds.has(swap.requestId)) continue;
            const existing = seen.get(swap.requestId);
            if (!existing || (swap.lastUpdated || 0) > (existing.lastUpdated || 0)) {
                seen.set(swap.requestId, swap);
            }
        }
        const pruned = Array.from(seen.values());
        if (pruned.length !== allSwaps.length) {
            setSwapsArray(pruned);
        }

        // ─── Show banner ───────────────────────────────────────────────────────
        const remaining = loadActiveSwaps();
        if (remaining.length > 0) {
            showResumeBanner(remaining, handleResumeSwap, handleResolveSwap);
            console.log('[CHAIN CHECK] Banner shown with', remaining.length, 'active swap(s)');
        } else {
            hideResumeBanner();
            console.log('[CHAIN CHECK] No active swaps found on chain');
        }
    } catch (error) {
        console.error('[CHAIN CHECK] Unexpected error checking for active swaps on chain:', error);
    }
}

/**
 * Handle Co-LP tab click - load capacity and show appropriate view
 */
async function handleCoLPTab() {
    showCoLPTab();
    await refreshCoLPBalance();
    await checkCoLPLPStatus();
    await handleRefreshCoLPPositions();
}

/**
 * Refresh and render user's active Co-LP positions
 */
async function handleRefreshCoLPPositions() {
    const listEl = document.getElementById('co-lp-positions-list');
    const refreshBtn = document.getElementById('co-lp-refresh-positions');
    if (!listEl) return;

    const address = getUserAddress();
    if (!address) {
        listEl.innerHTML = '<div class="positions-empty">Connect wallet to see your positions</div>';
        return;
    }

    // Show loading state
    if (refreshBtn) refreshBtn.classList.add('spinning');
    listEl.innerHTML = '<div class="positions-empty">Loading positions...</div>';

    try {
        const coLPFlow = getCoLPFlow();
        await coLPFlow.init();
        const positions = await coLPFlow.getUserActivePositions();

        if (positions.length === 0) {
            listEl.innerHTML = '<div class="positions-empty">No active Co-LP positions yet. Open one below!</div>';
            return;
        }

        listEl.innerHTML = positions.map(p => {
            const vaultShort = `${p.vault.slice(0, 6)}...${p.vault.slice(-4)}`;
            return `
                <div class="position-card" data-token-id="${p.tokenId}">
                    <div class="position-info">
                        <span class="position-token">#${p.tokenId}</span>
                        <span class="position-meta">Vault: ${vaultShort} · ${p.wsxmrAmount} wsXMR · Range: ${p.rangeBps} bps</span>
                    </div>
                    <div class="position-actions">
                        <button class="btn-rebalance" data-token-id="${p.tokenId}">Rebalance</button>
                        <button class="btn-unwind" data-token-id="${p.tokenId}">Close</button>
                    </div>
                </div>
            `;
        }).join('');

        // Wire up action buttons on each card
        listEl.querySelectorAll('.btn-rebalance').forEach(btn => {
            btn.addEventListener('click', () => {
                const tokenId = btn.dataset.tokenId;
                const tokenIdInput = document.getElementById('co-lp-token-id');
                if (tokenIdInput) tokenIdInput.value = tokenId;
                // Scroll to manage section
                tokenIdInput?.scrollIntoView({ behavior: 'smooth', block: 'center' });
            });
        });
        listEl.querySelectorAll('.btn-unwind').forEach(btn => {
            btn.addEventListener('click', async () => {
                const tokenId = btn.dataset.tokenId;
                const tokenIdInput = document.getElementById('co-lp-token-id');
                if (tokenIdInput) tokenIdInput.value = tokenId;
                await handleCoLPUnwind();
            });
        });

    } catch (error) {
        console.error('Error refreshing Co-LP positions:', error);
        listEl.innerHTML = `<div class="positions-empty">Could not load positions: ${error.message}</div>`;
    } finally {
        if (refreshBtn) refreshBtn.classList.remove('spinning');
    }
}

/**
 * Render positions list HTML from array
 */
function renderCoLPPositions(positions) {
    const listEl = document.getElementById('co-lp-positions-list');
    if (!listEl) return;

    if (positions.length === 0) {
        listEl.innerHTML = '<div class="positions-empty">No active Co-LP positions</div>';
        return;
    }
}

/**
 * Refresh wsXMR balance shown in Co-LP panel
 */
async function refreshCoLPBalance() {
    try {
        const { getUserAddress, getWsXmrBalance } = await import('./viemClient.js');
        const address = getUserAddress();
        const balanceEl = document.getElementById('co-lp-user-balance');
        if (address && balanceEl) {
            const balance = await getWsXmrBalance(address);
            balanceEl.textContent = (Number(balance) / 1e8).toFixed(4);
        } else if (balanceEl) {
            balanceEl.textContent = '0';
        }
    } catch (error) {
        console.warn('Could not refresh Co-LP balance:', error.message);
    }
}

/**
 * Check if user is an LP and show LP-only settings
 */
async function checkCoLPLPStatus() {
    try {
        const coLPFlow = getCoLPFlow();
        const isLP = await coLPFlow.isLP();
        const settingsEl = document.getElementById('co-lp-lp-settings');
        if (settingsEl) {
            if (isLP) {
                settingsEl.classList.remove('hidden');
                // Load current max range from vault
                const userAddress = getUserAddress();
                if (userAddress) {
                    const vault = await coLPFlow.getVault(userAddress);
                    const maxRangeInput = document.getElementById('co-lp-max-range');
                    if (maxRangeInput && vault && vault.maxCoLPRangeBps) {
                        maxRangeInput.value = Number(vault.maxCoLPRangeBps);
                    }
                }
            } else {
                settingsEl.classList.add('hidden');
            }
        }
    } catch (error) {
        console.warn('Error checking LP status for Co-LP:', error.message);
    }
}

/**
 * Handle Co-LP vault selection - fetch and display capacity
 */
async function handleCoLPVaultSelect() {
    const select = document.getElementById('co-lp-vault-select');
    const capacityDiv = document.getElementById('co-lp-capacity');
    if (!select || !capacityDiv) return;

    const lpVault = select.value;
    if (!lpVault) {
        capacityDiv.classList.add('hidden');
        return;
    }

    try {
        const coLPFlow = getCoLPFlow();
        const capacity = await coLPFlow.getCoLPCapacity(lpVault);
        const capacityWsxmr = Number(capacity) / 1e8;

        capacityDiv.innerHTML = `<p><strong>Co-LP Capacity:</strong> ${capacityWsxmr.toFixed(4)} wsXMR available</p>`;
        capacityDiv.classList.remove('hidden');
    } catch (error) {
        console.warn('Could not fetch Co-LP capacity:', error.message);
        capacityDiv.classList.add('hidden');
    }
}

/**
 * Handle open Co-LP position
 */
async function handleCoLPOpen() {
    const amountInput = document.getElementById('co-lp-amount');
    const vaultSelect = document.getElementById('co-lp-vault-select');

    if (!getUserAddress()) {
        showError('Wallet Required', 'Please connect your wallet');
        return;
    }

    const amount = parseFloat(amountInput?.value);
    const vaultAddress = vaultSelect?.value;

    if (!amount || amount <= 0) {
        showError('Invalid Input', 'Enter a valid wsXMR amount');
        return;
    }
    if (!vaultAddress) {
        showError('Invalid Input', 'Select an LP vault');
        return;
    }

    try {
        const coLPFlow = getCoLPFlow();
        await coLPFlow.init();

        // Default deadline: 10 minutes from now
        const deadline = Math.floor(Date.now() / 1000) + 600;

        const { receipt, tokenId } = await coLPFlow.userOpenCoLP(vaultAddress, amount, deadline);

        if (tokenId) {
            showSuccess('Position Opened', `Co-LP position created with token ID: ${tokenId}`);
        } else {
            showSuccess('Position Opened', 'Co-LP position created successfully');
        }

        await refreshCoLPBalance();
        // Refresh capacity display
        await handleCoLPVaultSelect();
        // Refresh active positions list
        await handleRefreshCoLPPositions();
    } catch (error) {
        console.error('Open Co-LP error:', error);
        showError('Open Co-LP Error', error.message);
    }
}

/**
 * Handle unwind Co-LP position
 */
async function handleCoLPUnwind() {
    const tokenIdInput = document.getElementById('co-lp-token-id');
    const tokenId = tokenIdInput?.value?.trim();

    if (!getUserAddress()) {
        showError('Wallet Required', 'Please connect your wallet');
        return;
    }
    if (!tokenId || isNaN(Number(tokenId))) {
        showError('Invalid Input', 'Enter a valid position token ID');
        return;
    }

    try {
        const coLPFlow = getCoLPFlow();
        await coLPFlow.init();

        const deadline = Math.floor(Date.now() / 1000) + 600;
        await coLPFlow.unwindCoLP(tokenId, deadline);

        showSuccess('Position Unwound', `Co-LP position ${tokenId} has been closed`);
        await handleRefreshCoLPPositions();
    } catch (error) {
        console.error('Unwind Co-LP error:', error);
        showError('Unwind Co-LP Error', error.message);
    }
}

/**
 * Handle rebalance Co-LP position
 */
async function handleCoLPRebalance() {
    const tokenIdInput = document.getElementById('co-lp-token-id');
    const rangeBpsInput = document.getElementById('co-lp-rebalance-bps');
    const tokenId = tokenIdInput?.value?.trim();
    const rangeBps = Number(rangeBpsInput?.value);

    if (!getUserAddress()) {
        showError('Wallet Required', 'Please connect your wallet');
        return;
    }
    if (!tokenId || isNaN(Number(tokenId))) {
        showError('Invalid Input', 'Enter a valid position token ID');
        return;
    }
    if (!rangeBps || rangeBps < 1000 || rangeBps > 10000) {
        showError('Invalid Input', 'Range must be between 1000 and 10000 bps');
        return;
    }

    try {
        const coLPFlow = getCoLPFlow();
        await coLPFlow.init();

        const deadline = Math.floor(Date.now() / 1000) + 600;
        await coLPFlow.rebalanceCoLP(tokenId, rangeBps, deadline);

        showSuccess('Position Rebalanced', `Co-LP position ${tokenId} rebalanced to ${rangeBps} bps range`);
        await handleRefreshCoLPPositions();
    } catch (error) {
        console.error('Rebalance Co-LP error:', error);
        showError('Rebalance Co-LP Error', error.message);
    }
}

/**
 * Handle set max Co-LP range (LP only)
 */
async function handleCoLPSetRange() {
    const maxRangeInput = document.getElementById('co-lp-max-range');
    const newMaxBps = Number(maxRangeInput?.value);

    if (!getUserAddress()) {
        showError('Wallet Required', 'Please connect your wallet');
        return;
    }
    if (!newMaxBps || newMaxBps < 1000 || newMaxBps > 10000) {
        showError('Invalid Input', 'Range must be between 1000 and 10000 bps');
        return;
    }

    try {
        const coLPFlow = getCoLPFlow();
        await coLPFlow.init();

        await coLPFlow.setMaxCoLPRange(newMaxBps);
        showSuccess('Range Updated', `Max Co-LP range set to ${newMaxBps} bps`);
    } catch (error) {
        console.error('Set range error:', error);
        showError('Set Range Error', error.message);
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
    elements.coLPPanel.classList.add('hidden');
    elements.lpPanel.classList.remove('hidden');
    
    // Update tab buttons
    elements.tabMint.classList.remove('active');
    elements.tabBurn.classList.remove('active');
    elements.tabCoLP.classList.remove('active');
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
        const lpPanel = getLPPanel();
        const isLP = await lpPanel.init();
        
        if (isLP) {
            // User is an LP - show stats view
            const vaultData = await lpPanel.loadVaultData();
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
        const { vault, health, debt } = vaultData;
        
        console.log('Vault pending debt:', vault.pendingDebt);
        
        // Update UI with vault stats
        document.getElementById('lp-collateral').textContent = `${(Number(vault.collateralShares) / 1e18).toFixed(2)} sDAI`;
        document.getElementById('lp-debt').textContent = `${(Number(debt) / 1e8).toFixed(4)} wsXMR`;
        document.getElementById('lp-pending-debt').textContent = `${(Number(vault.pendingDebt) / 1e8).toFixed(4)} wsXMR`;
        document.getElementById('lp-health').textContent = `${(Number(health) / 1e16).toFixed(0)}%`;
        
        // Update settings inputs
        document.getElementById('lp-mint-fee').value = Number(vault.mintFeeBps);
        document.getElementById('lp-burn-fee').value = Number(vault.burnRewardBps);
        document.getElementById('lp-max-mint').value = Number(vault.maxMintBps) / 100;
        document.getElementById('lp-griefing').value = (Number(vault.mintGriefingDeposit) / 1e18).toFixed(3);
        
        // TODO: Fetch fees earned from events
        document.getElementById('lp-fees').textContent = '0 xDAI';
        
        console.log('LP stats loaded for', address);
    } catch (error) {
        console.error('Error loading LP stats:', error);
    }
}

/**
 * Handle resume swap (called when user clicks Resume on a specific swap)
 * @param {Object} specificSwap - Optional specific swap to resume; falls back to most recent
 */
async function handleResumeSwap(specificSwap) {
    const swap = specificSwap || loadActiveSwap();
    if (!swap) {
        showError('Resume Error', 'No active swap found');
        return;
    }

    if (!swap.publicSpendKey) {
        showResumeError(swap.requestId, 'This swap was created before auto-save. Click Resolve to cancel it on-chain.');
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
            // Try to load the seed for this mint if we have the publicSpendKey
            if (swap.publicSpendKey) {
                const { loadSeed, hasStoredSeed } = await import('./seedStorage.js');
                const { getPhantomAgent } = await import('./phantomAgent.js');
                
                // Remove '0x' prefix if present
                const pubKeyHex = swap.publicSpendKey.startsWith('0x') 
                    ? swap.publicSpendKey.slice(2) 
                    : swap.publicSpendKey;
                
                if (hasStoredSeed(pubKeyHex)) {
                    console.log('Loading seed for this mint...');
                    const seed = await loadSeed(pubKeyHex);
                    if (seed) {
                        const agent = getPhantomAgent();
                        await agent.restoreFromSeed(seed);
                        console.log('✅ Seed restored for mint');
                    } else {
                        console.warn('⚠️ Could not decrypt seed - you may need to sign to decrypt');
                    }
                } else {
                    console.warn('⚠️ No stored seed found for this mint - finalization may fail');
                }
            }
            
            currentMintFlow = new MintFlow();
            showMintTab();
            trackMintProgress(currentMintFlow);
            await currentMintFlow.resume(swap);
        } else if (swap.type === 'burn') {
            currentBurnFlow = new BurnFlow();
            showBurnTab();
            trackBurnProgress(currentBurnFlow);
            await currentBurnFlow.resume(swap);
        }
        
        // Banner stays visible so user can see other active swaps

    } catch (error) {
        console.error('Error resuming swap:', error);
        showError('Resume Error', error.message);
    }
}

/**
 * Handle resolve swap (called when user clicks Resolve on an unresumable swap).
 * Attempts to cancel PENDING swaps on-chain to recover deposits/tokens.
 */
async function handleResolveSwap(swap) {
    if (!swap) return;

    // Ensure wallet is connected before any on-chain action
    let address = getUserAddress();
    if (!address) {
        try {
            address = await handleConnectWallet();
        } catch (e) {
            showError('Wallet Required', 'Please connect your wallet to resolve this swap.');
            return;
        }
    }

    try {
        // PENDING mint: cancel on-chain to recover griefing deposit
        if (swap.type === 'mint' && (swap.state === 'awaiting-lp-key' || swap.state === 'evm-init' || swap.state === 'initiated')) {
            console.log('Resolving stale mint on-chain:', swap.requestId);
            const { writeHub } = await import('./viemClient.js');
            const receipt = await writeHub('cancelMint', [swap.requestId]);
            console.log('cancelMint tx:', receipt.transactionHash);
            showSuccess('Mint Cancelled', 'Your griefing deposit has been refunded.');
        }
        // REQUESTED burn: cancel on-chain to recover wsXMR
        else if (swap.type === 'burn' && swap.state === 'evm-request') {
            console.log('Resolving stale burn on-chain:', swap.requestId);
            const { writeHub } = await import('./viemClient.js');
            const receipt = await writeHub('cancelBurn', [swap.requestId]);
            console.log('cancelBurn tx:', receipt.transactionHash);
            showSuccess('Burn Cancelled', 'Your wsXMR has been returned.');
        }
        // Beyond PENDING/REQUESTED: stuck without secret, just clear locally
        else {
            showSuccess('Swap Cleared', 'The swap has been removed from your browser.');
        }

        // Remove from localStorage
        if (swap.requestId) {
            removeActiveSwap(swap.requestId);
        } else {
            clearActiveSwap();
        }

        // Refresh banner
        const remaining = loadActiveSwaps();
        if (remaining.length > 0) {
            showResumeBanner(remaining, handleResumeSwap, handleResolveSwap);
        } else {
            hideResumeBanner();
        }
    } catch (error) {
        console.error('Error resolving swap:', error);
        showError('Resolve Failed', error.message || 'Could not resolve this swap on-chain.');
    }
}

/**
 * Load available LP vaults
 */
async function loadVaults() {
    try {
        // Hardcoded list of known LP vaults
        // In production, this would query events or use a registry
        const knownVaults = [
            '0x492c0b9F298cC49FE2644a2EBc6eA8dF848c72FB', // Your LP vault
        ];
        
        const activeVaults = [];
        let totalCollateralWei = 0n;

        // Fetch oracle prices once for capacity calculation
        let xmrPrice = 150;   // fallback USD per XMR
        let collPrice = 1.0;  // fallback USD per sDAI
        try {
            const xmrPriceWei = await readHub('getXmrPrice');
            const collPriceWei = await readHub('getCollateralPrice');
            xmrPrice = Number(xmrPriceWei) / 1e18;
            collPrice = Number(collPriceWei) / 1e18;
            console.log('Oracle prices:', { xmrPrice, collPrice });
        } catch (e) {
            console.warn('Could not fetch oracle prices, using fallbacks:', e.message);
        }

        for (const vaultAddress of knownVaults) {
            try {
                console.log('Fetching vault data for:', vaultAddress);
                const vaultData = await readHub('getVault', [vaultAddress]);

                console.log('Raw vault data:', vaultData);
                console.log('Collateral shares:', vaultData.collateralShares?.toString());
                console.log('Debt:', vaultData.normalizedDebt?.toString());
                console.log('Active:', vaultData.active);

                const hasCollateral = vaultData && vaultData.collateralShares && BigInt(vaultData.collateralShares.toString()) > 0n;

                if (hasCollateral || vaultData.active) {
                    const collAmount = Number(vaultData.collateralShares) / 1e18;
                    const debtAmount = Number(vaultData.normalizedDebt) / 1e8;
                    const pendingDebtAmount = Number(vaultData.pendingDebt) / 1e8;
                    const totalDebt = debtAmount + pendingDebtAmount;
                    const debtValueUsd = debtAmount * xmrPrice;
                    const pendingDebtValueUsd = pendingDebtAmount * xmrPrice;
                    const totalDebtValueUsd = totalDebt * xmrPrice;
                    
                    const usedCollateral = collPrice > 0 ? debtValueUsd / collPrice : 0;
                    const pendingCollateral = collPrice > 0 ? pendingDebtValueUsd / collPrice : 0;
                    // Buffer = extra 50% collateral required to maintain 150% ratio (on total debt)
                    const bufferCollateral = (usedCollateral + pendingCollateral) * 0.5;
                    const freeCollateral = Math.max(0, collAmount - usedCollateral - pendingCollateral - bufferCollateral);

                    console.log('Vault capacity:', {
                        collAmount,
                        debtAmount,
                        pendingDebtAmount,
                        totalDebt,
                        xmrPrice,
                        collPrice,
                        debtValueUsd,
                        pendingDebtValueUsd,
                        usedCollateral,
                        pendingCollateral,
                        bufferCollateral,
                        freeCollateral
                    });

                    const vault = {
                        address: vaultAddress,
                        name: `LP Vault ${vaultAddress.slice(0, 6)}...${vaultAddress.slice(-4)}`,
                        collateral: vaultData.collateralShares,
                        debt: vaultData.normalizedDebt,
                        pendingDebt: vaultData.pendingDebt,
                        usedCollateral,
                        pendingCollateral,
                        bufferCollateral,
                        freeCollateral,
                    };
                    console.log('Adding active vault:', vault);
                    activeVaults.push(vault);

                    totalCollateralWei += BigInt(vaultData.collateralShares.toString());
                } else {
                    console.warn('Vault has no collateral and is not active');
                }
            } catch (err) {
                console.error(`Failed to fetch vault ${vaultAddress}:`, err);
            }
        }
        
        // Update stats bar with dynamic values
        const vaultsStatEl = document.getElementById('vaults-stat');
        if (vaultsStatEl) {
            vaultsStatEl.textContent = activeVaults.length.toString();
        }
        
        // Update TVL (convert sDAI shares to approximate USD value)
        // sDAI is roughly 1:1 with DAI, so we can approximate
        const tvlStatEl = document.getElementById('tvl-stat');
        if (tvlStatEl && totalCollateralWei > 0n) {
            const collateralInDai = Number(totalCollateralWei) / 1e18;
            // Assuming DAI ≈ $1
            const tvlUsd = collateralInDai;
            if (tvlUsd >= 1000) {
                tvlStatEl.textContent = `$${(tvlUsd / 1000).toFixed(1)}K`;
            } else {
                tvlStatEl.textContent = `$${tvlUsd.toFixed(2)}`;
            }
        } else if (tvlStatEl) {
            tvlStatEl.textContent = '$0';
        }
        
        if (activeVaults.length === 0) {
            // Fallback to showing the known vault even if query failed
            activeVaults.push({
                address: '0x492c0b9F298cC49FE2644a2EBc6eA8dF848c72FB',
                name: 'LP Vault 0x492c...72FB'
            });
        }
        
        populateVaults(activeVaults);
        
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
        const vaultData = await readHub('getVault', [vaultAddress]);
        
        const vaultInfo = {
            totalXmrLocked: vaultData[0],
            totalCollateral: vaultData[1],
            collateralToken: vaultData[2],
            collateralizationRatio: vaultData[3],
            mintGriefingDeposit: vaultData[4],
            isActive: vaultData[5],
            lpVault: vaultAddress
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
    
    // Require wallet connection
    if (!getUserAddress()) {
        showError('Wallet Required', 'Please connect your wallet to start a mint');
        return;
    }
    
    const amount = parseFloat(elements.mintAmount.value);
    
    // Validate inputs
    if (!amount || amount <= 0) {
        showError('Invalid Input', 'Please enter a valid amount');
        return;
    }
    
    try {
        disableInputs(true);
        
        // Create new mint flow
        currentMintFlow = new MintFlow();
        
        // Setup progress tracking
        trackMintProgress(currentMintFlow);
        
        // Use the default LP vault from config
        const { CONTRACTS } = await import('./config.js');
        
        // Start the flow with the LP vault that has the running LP node
        await currentMintFlow.start(CONTRACTS.defaultLpVault, amount);
        
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
    let lastState = null;
    
    // Monitor state changes
    const checkState = setInterval(() => {
        // Only update UI if state actually changed
        if (flow.state === lastState) {
            return;
        }
        
        lastState = flow.state;
        
        switch (flow.state) {
            case 'init':
                updateMintProgress('init', 'Requesting signature...');
                break;
            case 'evm-init':
                completeMintStep('init');
                updateMintProgress('evm-init', 'Submitting griefing deposit to blockchain...');
                break;
            case 'initiated':
            case 'awaiting-lp-key':
                completeMintStep('evm-init');
                updateMintProgress('deposit', 'Waiting for LP to provide deposit address...');
                break;
            case 'deposit':
                completeMintStep('evm-init');
                updateMintProgress('deposit', 'Waiting for XMR deposit...');
                const depositAddr = flow.depositAddress || flow.agent.getMoneroAddress();
                showMintDepositInfo(depositAddr, flow.xmrAmount);
                break;
            case 'lp-verifying':
                completeMintStep('deposit');
                updateMintProgress('lp-confirm', 'LP is updating oracle prices and verifying your XMR deposit...');
                break;
            case 'lp-ready':
            case 'lp-confirm':
                completeMintStep('deposit');
                updateMintProgress('lp-confirm', 'LP verified! Preparing to mint...');
                break;
            case 'finalize':
                completeMintStep('lp-confirm');
                updateMintProgress('finalize', 'Revealing secret and minting wsXMR...');
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
    
    // Require wallet connection
    if (!getUserAddress()) {
        console.log('Wallet not connected');
        return;
    }
    
    const amount = parseFloat(elements.burnAmount.value);
    const destination = elements.burnXmrDestination.value;
    const vaultAddress = elements.burnVaultSelect.value;
    
    // Validate inputs
    if (!amount || amount <= 0) {
        console.log('Invalid amount');
        return;
    }
    
    if (!destination || destination.length < 95) {
        console.log('Invalid Monero address');
        return;
    }
    
    if (!vaultAddress) {
        console.log('No vault selected');
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
        
        // Success - just log it
        console.log(`Burn complete: ${amount} wsXMR`);
        
        // Update balance
        const address = getUserAddress();
        const balance = await getWsXmrBalance(address);
        updateBalance(balance);
        
        // Reset UI
        resetBurnUI();
        
    } catch (error) {
        console.error('Burn error:', error);
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
