// Mint Flow - XMR to wsXMR (Diamond Architecture + LP Server Integration)

import { CONTRACTS, ABIS, DECIMALS, SWAP_CONFIG } from './config.js';
import { readHub, writeHub, watchContractEvent, getUserAddress } from './viemClient.js';
import { getPhantomAgent } from './phantomAgent.js';
import { saveActiveSwap, updateSwapState, clearActiveSwap, saveToHistory } from './storage.js';
import { keccak256, toHex, parseEther } from 'https://esm.sh/viem@2.7.0';
import { startDeadlineTimer, startStatusPolling, stopTimers } from './mintFlowTimers.js';
import { showLPVerificationStatus, updateMintProgress } from './ui.js';

export class MintFlow {
    constructor() {
        this.state = 'idle';
        this.requestId = null;
        this.agent = null;
        this.lpVault = null;
        this.xmrAmount = null;
        this.wsxmrAmount = null;
        this.griefingDeposit = null;
        this.timeout = null;
        this.depositAddress = null;
        this.eventWatchers = [];
    }

    async start(lpVault, xmrAmount) {
        console.log('Starting mint flow:', { lpVault, xmrAmount });

        if (xmrAmount <= 0) {
            throw new Error('Amount must be greater than 0');
        }

        this.lpVault = lpVault;
        this.xmrAmount = xmrAmount;
        this.timeoutDuration = SWAP_CONFIG.defaultTimeout;

        // Setup cancel button
        this.setupCancelButton();

        await this.getQuote();
        await this.initializeAgent();
        await this.checkOracleFreshness();
        await this.initiateOnEVM();
        await this.notifyLP();
        if (this.state === 'expired') return;
        await this.waitForLPReady();
        if (this.state === 'expired') return;
        await this.finalize();
    }

    setupCancelButton() {
        const cancelBtn = document.getElementById('cancel-mint');
        if (cancelBtn) {
            cancelBtn.onclick = () => this.cancelMint();
        }
    }

    setupConfirmSentButton() {
        const confirmBtn = document.getElementById('confirm-sent-xmr');
        if (confirmBtn) {
            confirmBtn.onclick = () => {
                showLPVerificationStatus();
                // Resolve the promise waiting for user confirmation
                if (this.userConfirmResolve) {
                    this.userConfirmResolve();
                }
            };
        }
    }

    async cancelMint() {
        try {
            const confirmed = confirm('Are you sure you want to cancel this mint? This action cannot be undone.');
            if (!confirmed) return;

            console.log('Cancelling mint:', this.requestId);
            
            // Call cancelMint on the contract
            const { getWalletClient, getPublicClient } = await import('./viemClient.js');
            
            const walletClient = await getWalletClient();
            const publicClient = await getPublicClient();
            
            const hash = await walletClient.writeContract({
                address: CONTRACTS.hub,
                abi: ABIS.hub,
                functionName: 'cancelMint',
                args: [this.requestId]
            });
            
            console.log('Cancel transaction sent:', hash);
            
            // Wait for confirmation
            await publicClient.waitForTransactionReceipt({ hash });
            
            console.log('Mint cancelled successfully');
            
            // Save to history
            const { saveToHistory, removeActiveSwap } = await import('./storage.js');
            saveToHistory({
                type: 'mint',
                requestId: this.requestId,
                xmrAmount: this.xmrAmount,
                wsxmrAmount: this.wsxmrAmount,
                lpVault: this.lpVault,
                status: 'Cancelled',
                timestamp: Date.now(),
                completedAt: Date.now()
            });
            
            // Clear from active storage
            removeActiveSwap(this.requestId);
            
            // Show success
            const { showSuccess, resetMintUI } = await import('./ui.js');
            showSuccess('Mint Cancelled', 'The mint has been cancelled. You can now start a new mint.');
            
            // Reset UI
            resetMintUI();
            
            // Refresh history display
            const { displaySwapHistory } = await import('./swapHistory.js');
            displaySwapHistory();
            
        } catch (error) {
            console.error('Error cancelling mint:', error);
            const { showError } = await import('./ui.js');
            showError('Cancel Failed', error.message || 'Failed to cancel mint');
        }
    }

    async getQuote() {
        this.state = 'quote';
        updateSwapState({ 
            type: 'mint',
            state: this.state,
            lpVault: this.lpVault,
            xmrAmount: this.xmrAmount
        });

        console.log('Getting quote from on-chain vault...');
        
        const vault = await readHub('getVault', [this.lpVault]);
        this.griefingDeposit = vault.mintGriefingDeposit;
        
        const xmrAtomic = BigInt(Math.floor(this.xmrAmount * Math.pow(10, DECIMALS.XMR)));
        this.wsxmrAmount = await readHub('calculateWsxmrAmount', [xmrAtomic]);
        
        updateSwapState({
            griefingDeposit: this.griefingDeposit.toString(),
            wsxmrAmount: this.wsxmrAmount.toString()
        });
    }

    async initializeAgent() {
        this.state = 'init';
        updateSwapState({ state: this.state });

        console.log('Initializing Phantom Agent...');

        // Reset singleton to prevent state pollution from previous mints
        const { resetPhantomAgent } = await import('./phantomAgent.js');
        resetPhantomAgent();
        
        this.agent = getPhantomAgent();
        const agentData = await this.agent.initialize('MINT', this.xmrAmount.toString());

        console.log('Agent initialized:', agentData);

        // Store seed for later resume (encrypted in browser)
        const { storeSeed } = await import('./seedStorage.js');
        const publicSpendKeyHex = toHex(this.agent.keySet.publicSpendKey);
        try {
            await storeSeed(this.agent.seed, publicSpendKeyHex);
            console.log('Seed stored for resume');
        } catch (e) {
            console.warn('Could not store seed:', e.message);
        }

        updateSwapState({
            moneroAddress: agentData.moneroAddress,
            commitment: agentData.commitment,
            publicSpendKey: publicSpendKeyHex
        });
    }

    async checkOracleFreshness() {
        console.log('Checking oracle freshness...');
        
        try {
            // Try to get price with 2 minute staleness tolerance
            await readHub('getXmrPrice', []);
            console.log('Oracle prices are fresh');
        } catch (error) {
            // Prices are stale - try to update them
            console.warn('Oracle prices are stale, attempting update...');
            try {
                updateMintProgress('evm-init', 'Updating XMR price onchain...');
                await this.updatePrices();
            } catch (updateError) {
                console.warn('Could not update prices from UI:', updateError.message);
                console.log('Continuing anyway - LP node should handle price updates');
                // Don't throw - the LP node will update prices
            }
        }
    }

    async updatePrices() {
        const { updateOraclePrices } = await import('./redstoneWrapper.js?v=' + Date.now());
        await updateOraclePrices();
        console.log('Prices updated, continuing with mint');
    }

    async initiateOnEVM() {
        this.state = 'evm-init';
        updateSwapState({ state: this.state });

        console.log('Initiating mint on EVM...');

        const userAddress = getUserAddress();
        const xmrAmountAtomic = BigInt(Math.floor(this.xmrAmount * Math.pow(10, DECIMALS.XMR)));
        const commitment = this.agent.getCommitment();
        const userPublicKey = toHex(this.agent.keySet.publicSpendKey);

        console.log('Initiating mint with params:', {
            lpVault: this.lpVault,
            initiator: userAddress,
            wsxmrAmount: this.wsxmrAmount.toString(),
            commitment,
            userPublicKey,
            griefingDeposit: this.griefingDeposit.toString()
        });

        let receipt;
        try {
            receipt = await writeHub(
                'initiateMint',
                [
                    this.lpVault,
                    userAddress,
                    xmrAmountAtomic,
                    commitment,
                    userPublicKey
                ],
                this.griefingDeposit
            );
        } catch (error) {
            // Check if it's a StalePrice error (0x19abf40e)
            if (error.message && error.message.includes('0x19abf40e')) {
                throw new Error('Oracle prices are stale. Please wait a moment for the LP node to update prices, then try again.');
            }
            throw error;
        }

        console.log('Mint initiated, tx:', receipt.transactionHash);

        const mintInitiatedEvent = receipt.logs.find(log => 
            log.topics[0] === keccak256(toHex('MintInitiated(bytes32,address,address,address,uint256,uint256,uint256,bytes32,bytes32,uint256)'))
        );

        if (mintInitiatedEvent) {
            this.requestId = mintInitiatedEvent.topics[1];
            console.log('Request ID:', this.requestId);
            
            // Query the on-chain mint request to get the blockchain timeout
            const mintReq = await readHub('getMintRequest', [this.requestId]);
            this.timeout = mintReq.timeout;
            console.log('Mint timeout (block):', this.timeout.toString());
            
            // Save complete swap state to localStorage
            const { addOrUpdateActiveSwap } = await import('./storage.js');
            const publicSpendKey = toHex(this.agent.keySet.publicSpendKey);
            addOrUpdateActiveSwap({
                type: 'mint',
                requestId: this.requestId,
                state: 'initiated',
                lpVault: this.lpVault,
                xmrAmount: this.xmrAmount,
                wsxmrAmount: this.wsxmrAmount.toString(),
                griefingDeposit: this.griefingDeposit.toString(),
                txHash: receipt.transactionHash,
                timeout: this.timeout.toString(),
                publicSpendKey: publicSpendKey,
                timestamp: Date.now(),
                lastUpdated: Date.now()
            });
        } else {
            throw new Error('Could not extract requestId from transaction');
        }

        this.state = 'initiated';
        updateSwapState({
            type: 'mint',
            requestId: this.requestId,
            state: this.state,
            commitment: this.agent.getCommitment(),
            publicSpendKey: toHex(this.agent.keySet.publicSpendKey)
        });
    }

    async notifyLP() {
        console.log('Waiting for LP to provide public key...');
        updateSwapState({ requestId: this.requestId, state: 'awaiting-lp-key', message: 'Waiting for LP to provide public key...' });
        
        // Start deadline timer immediately so user sees countdown from the start
        await startDeadlineTimer(this);
        
        // Wait for LP to call provideLPKey() on-chain (polls indefinitely, checks expiry)
        const lpPublicKey = await this.waitForLPKey();
        
        // If null returned, mint expired on-chain while waiting
        if (!lpPublicKey) {
            console.log('Mint expired on-chain while waiting for LP key');
            this.state = 'expired';
            updateSwapState({ requestId: this.requestId, state: 'expired', message: 'Mint expired. Cancel to refund your deposit.' });
            return;
        }
        
        console.log('LP public keys received:', lpPublicKey);
        
        // Derive shared Monero deposit address locally using LP's public keys
        console.log('Deriving shared Monero deposit address...');
        this.depositAddress = await this.agent.deriveSharedMoneroAddress(lpPublicKey.spendKey, lpPublicKey.viewKey);
        console.log('Monero Deposit Address:', this.depositAddress);
        console.log('Send exactly', this.xmrAmount, 'XMR to this address');
        
        updateSwapState({
            requestId: this.requestId,
            state: 'deposit',
            depositAddress: this.depositAddress,
            lpPublicSpendKey: lpPublicKey.spendKey,
            lpPublicViewKey: lpPublicKey.viewKey
        });

        this.state = 'deposit';
    }
    
    async waitForLPKey() {
        console.log('Polling for LP public key on-chain...');
        
        // If we don't have the on-chain timeout yet, query it now
        if (!this.timeout) {
            try {
                const mintReq = await readHub('getMintRequest', [this.requestId]);
                this.timeout = mintReq.timeout;
                console.log('Queried on-chain timeout (block):', this.timeout.toString());
            } catch (e) {
                console.warn('Could not query on-chain timeout, will skip expiry check:', e.message);
            }
        }
        
        let attempt = 0;
        while (true) {
            try {
                // First check if the mint has expired on-chain
                if (this.timeout) {
                    const { getPublicClient } = await import('./viemClient.js');
                    const publicClient = getPublicClient();
                    const currentBlock = await publicClient.getBlockNumber();
                    if (currentBlock >= this.timeout) {
                        console.log('Mint timeout reached on-chain while waiting for LP key');
                        return null;
                    }
                }
                
                const lpPublicSpendKey = await readHub('lpPublicKeys', [this.requestId]);
                const lpPublicViewKey = await readHub('lpPublicViewKeys', [this.requestId]);
                
                if (lpPublicSpendKey && lpPublicSpendKey !== '0x0000000000000000000000000000000000000000000000000000000000000000' &&
                    lpPublicViewKey && lpPublicViewKey !== '0x0000000000000000000000000000000000000000000000000000000000000000') {
                    return { spendKey: lpPublicSpendKey, viewKey: lpPublicViewKey };
                }
                
                if (attempt % 6 === 0) { // Log every 30 seconds
                    console.log('Still waiting for LP to provide public key...');
                }
                
                await new Promise(resolve => setTimeout(resolve, 5000));
                attempt++;
            } catch (error) {
                console.error('Error checking for LP key:', error);
                await new Promise(resolve => setTimeout(resolve, 5000));
                attempt++;
            }
        }
    }

    async waitForLPReady() {
        // Check on-chain status first so resume paths can skip unnecessary waits
        const { readHub } = await import('./viemClient.js');
        let mintRequest;
        try {
            mintRequest = await readHub('getMintRequest', [this.requestId]);
        } catch (e) {
            console.warn('Could not query mint request status:', e.message);
        }

        const isAlreadyReady = mintRequest && Number(mintRequest.status) === 3;
        const isExpired = mintRequest && Number(mintRequest.status) === 5;

        if (isExpired) {
            console.log('Mint expired on-chain');
            this.state = 'expired';
            updateSwapState({ requestId: this.requestId, state: 'expired', message: 'Mint expired. Cancel to refund your deposit.' });
            return;
        }

        // Only wait for user confirmation if not already in lp-verifying (i.e. not resuming mid-flow)
        if (!isAlreadyReady && this.state !== 'lp-verifying') {
            console.log('Waiting for user to confirm XMR sent...');
            this.setupConfirmSentButton();
            await new Promise((resolve) => {
                this.userConfirmResolve = resolve;
            });
        }

        console.log('User confirmed XMR sent. Now waiting for LP to verify...');

        updateSwapState({
            requestId: this.requestId,
            state: 'lp-verifying',
            message: 'LP is updating oracle prices and verifying your XMR deposit...'
        });
        showLPVerificationStatus();

        // If already ready, skip event watching and go straight to claim
        if (isAlreadyReady) {
            console.log('Mint is already ready (status check)');
            this.state = 'lp-ready';
            updateSwapState({ requestId: this.requestId, state: this.state });
            console.log('LP confirmed XMR received. Waiting for user to claim wsXMR...');
            await this.setupClaimButton();
            return new Promise((resolve) => {
                this.userClaimResolve = resolve;
            });
        }

        // Start deadline countdown timer
        await startDeadlineTimer(this);
        startStatusPolling(this);

        // First, check if MintReady event was already emitted in the past
        const { getPastEvents, getBlockNumber } = await import('./viemClient.js');
        const currentBlock = await getBlockNumber();
        const fromBlock = currentBlock - 1000n; // Check last ~1000 blocks
        
        console.log(`Checking for past MintReady events from block ${fromBlock} to ${currentBlock}...`);
        const pastEvents = await getPastEvents(
            CONTRACTS.hub,
            ABIS.hub,
            'MintReady',
            fromBlock,
            'latest',
            { requestId: this.requestId }
        );

        if (pastEvents && pastEvents.length > 0) {
            console.log('Found existing MintReady event - verifying on-chain status...');
        } else {
            console.log('No past MintReady event found, setting up watcher for new events...');
            
            // Watch for on-chain MintReady event
            await new Promise((resolve, reject) => {
                const unwatch = watchContractEvent(
                    CONTRACTS.hub,
                    ABIS.hub,
                    'MintReady',
                    { requestId: this.requestId },
                    (log) => {
                        console.log('MintReady event received');
                        unwatch();
                        resolve();
                    }
                );

                this.eventWatchers.push(unwatch);

                // Timeout after 30 minutes
                setTimeout(() => {
                    unwatch();
                    reject(new Error('LP ready timeout - MintReady event not received'));
                }, 1800000);
            });
        }

        // Verify current on-chain status before proceeding
        // MintReady event may have been emitted but state change not yet committed
        // Poll until status is actually READY (3) on-chain
        console.log('Waiting for on-chain status to become READY...');
        let currentMintRequest;
        let pollAttempts = 0;
        const maxPollAttempts = 60; // 5 minutes max (5 seconds * 60)
        
        while (pollAttempts < maxPollAttempts) {
            try {
                currentMintRequest = await readHub('getMintRequest', [this.requestId]);
                const status = Number(currentMintRequest.status);
                // MintStatus: 0=INVALID, 1=PENDING, 2=KEY_PROVIDED, 3=READY, 4=COMPLETED, 5=CANCELLED
                
                if (status === 5) {
                    console.log('Mint was cancelled by LP after MintReady event');
                    this.state = 'expired';
                    updateSwapState({ requestId: this.requestId, state: this.state });
                    const { showError } = await import('./ui.js');
                    showError('Mint Cancelled', 'The LP cancelled this mint. If you had a griefing deposit, you can withdraw it via Pending Returns.');
                    throw new Error('Mint cancelled by LP');
                }
                
                if (status === 4) {
                    console.log('Mint was already completed');
                    this.complete();
                    throw new Error('Mint already completed');
                }
                
                if (status === 3) {
                    console.log('On-chain status verified: READY');
                    this.state = 'lp-ready';
                    updateSwapState({ requestId: this.requestId, state: this.state });
                    break;
                }
                
                // Status is still PENDING (1) or KEY_PROVIDED (2) - wait and retry
                console.log(`Status is ${status}, waiting for READY (3)... (attempt ${pollAttempts + 1}/${maxPollAttempts})`);
                await new Promise(resolve => setTimeout(resolve, 5000));
                pollAttempts++;
                
            } catch (error) {
                if (error.message.includes('cancelled by LP') || 
                    error.message.includes('already completed')) {
                    throw error;
                }
                console.warn('Error checking status, retrying...', error.message);
                await new Promise(resolve => setTimeout(resolve, 5000));
                pollAttempts++;
            }
        }
        
        if (pollAttempts >= maxPollAttempts) {
            throw new Error('Timeout waiting for mint status to become READY on-chain. The LP may be experiencing issues.');
        }

        // LP has confirmed - now wait for user to claim wsXMR
        console.log('LP confirmed XMR received. Waiting for user to claim wsXMR...');
        await this.setupClaimButton();

        return new Promise((resolve) => {
            this.userClaimResolve = resolve;
        });
    }

    async setupClaimButton() {
        const { showClaimWsXmrButton } = await import('./ui.js');
        showClaimWsXmrButton(() => {
            console.log('User clicked Claim wsXMR');
            if (this.userClaimResolve) {
                this.userClaimResolve();
            }
        });
    }

    async finalize() {
        this.state = 'finalize';
        updateSwapState({ requestId: this.requestId, state: this.state });

        console.log('Finalizing mint...');

        try {
            await this._doFinalize();
        } catch (error) {
            // If an error occurred but state is still 'finalize', revert to 'lp-ready'
            // so the user can retry (unless error handler already set it to expired/completed)
            if (this.state === 'finalize') {
                this.state = 'lp-ready';
                updateSwapState({ requestId: this.requestId, state: this.state });
                this.setupClaimButton();
            }
            throw error;
        }
    }

    async _doFinalize() {
        // Verify status one more time before attempting finalize
        const { readHub } = await import('./viemClient.js');
        try {
            const mintReq = await readHub('getMintRequest', [this.requestId]);
            const status = Number(mintReq.status);
            
            if (status === 5) {
                const { showError } = await import('./ui.js');
                showError('Mint Cancelled', 'This mint was cancelled by the LP. If you had a griefing deposit, you can withdraw it via Pending Returns.');
                throw new Error('Mint was cancelled');
            }
            
            if (status === 4) {
                console.log('Mint already completed');
                this.complete();
                return;
            }
            
            if (status !== 3) {
                const { showError } = await import('./ui.js');
                showError('Invalid Status', `Cannot finalize mint - current status is ${status}. Expected status 3 (READY).`);
                throw new Error(`Invalid mint status: ${status}`);
            }
        } catch (error) {
            if (error.message.includes('cancelled') || error.message.includes('Invalid mint status')) {
                throw error;
            }
            // If we can't verify status (RPC error, etc.), don't blindly proceed
            console.error('Could not verify status before finalize:', error.message);
            throw new Error('Could not verify mint status before finalizing. Please check your connection and try again.');
        }

        const secret = this.agent.getSecret();

        let receipt;
        try {
            receipt = await writeHub('finalizeMint', [this.requestId, secret], 0n, 1000000n);
        } catch (error) {
            const isInvalidStatus = error.message && error.message.includes('InvalidStatus');
            if (isInvalidStatus) {
                // Query actual on-chain status to give precise guidance and update UI
                try {
                    const mintReq = await readHub('getMintRequest', [this.requestId]);
                    const status = Number(mintReq.status);
                    if (status === 4) {
                        console.log('Mint already completed on-chain');
                        this.complete();
                        return;
                    }
                    if (status === 5) {
                        this.state = 'expired';
                        updateSwapState({ requestId: this.requestId, state: 'expired', message: 'Mint was cancelled on-chain.' });
                        const { showError } = await import('./ui.js');
                        showError('Mint Cancelled', 'This mint was cancelled. If you had a griefing deposit, you can withdraw it via Pending Returns.');
                        throw new Error('Mint was cancelled');
                    }
                    if (status === 3) {
                        // Still READY — something else caused InvalidStatus (race condition?)
                        throw new Error('Mint is still READY but transaction simulation failed. Please try again.');
                    }
                    this.state = 'expired';
                    updateSwapState({ requestId: this.requestId, state: 'expired', message: `Mint status is ${status} (not READY). Cannot finalize.` });
                } catch (checkErr) {
                    if (checkErr.message.includes('already completed') ||
                        checkErr.message.includes('Mint was cancelled') ||
                        checkErr.message.includes('still READY')) {
                        throw checkErr;
                    }
                    console.warn('Could not query status after InvalidStatus:', checkErr.message);
                }
                const { showError } = await import('./ui.js');
                showError(
                    'Mint Cancelled or Expired', 
                    'This mint is no longer in READY status. The LP may have cancelled it. If you had a griefing deposit, you can withdraw it via Pending Returns.'
                );
                throw new Error('Mint status changed - cannot finalize');
            }
            
            const isStalePrice = error.message && (
                error.message.includes('StalePrice') ||
                error.message.includes('0x19abf40e')
            );
            if (isStalePrice) {
                console.warn('StalePrice on finalizeMint - attempting to update oracle prices...');
                try {
                    updateMintProgress('finalize', 'Updating XMR price onchain...');
                    await this.updatePrices();
                    console.log('Prices updated, retrying finalizeMint...');
                    receipt = await writeHub('finalizeMint', [this.requestId, secret], 0n, 1000000n);
                } catch (retryError) {
                    const stillStale = retryError.message && (
                        retryError.message.includes('StalePrice') ||
                        retryError.message.includes('0x19abf40e')
                    );
                    if (stillStale) {
                        throw new Error(
                            'Oracle prices are stale. The LP node typically updates prices automatically. ' +
                            'Please wait 1-2 minutes and try again.'
                        );
                    }
                    throw retryError;
                }
            } else {
                throw error;
            }
        }

        console.log('Mint finalized, tx:', receipt.transactionHash);

        this.complete();
    }

    complete() {
        this.state = 'completed';
        
        const swapData = {
            type: 'mint',
            requestId: this.requestId,
            lpVault: this.lpVault,
            xmrAmount: this.xmrAmount,
            wsxmrAmount: this.wsxmrAmount.toString(),
            state: 'completed',
            timestamp: Date.now()
        };
        
        saveToHistory(swapData);
        clearActiveSwap();
        this.cleanup();
        
        console.log('Mint flow completed successfully!');
    }

    async cancel() {
        console.log('Canceling mint...');

        if (this.requestId) {
            try {
                const mintReq = await readHub('getMintRequest', [this.requestId]);
                const status = Number(mintReq.status);
                // MintStatus: 0=INVALID, 1=PENDING, 2=KEY_PROVIDED, 3=READY, 4=COMPLETED, 5=CANCELLED
                if (status === 5) {
                    await writeHub('withdrawReturns', ['0x0000000000000000000000000000000000000000']);
                    console.log('Mint already cancelled; claimed refund via withdrawReturns');
                } else if (status === 1 || status === 2 || status === 3) {
                    await writeHub('cancelMint', [this.requestId]);
                    console.log('Mint request canceled on EVM');
                } else {
                    console.warn(`Mint status is ${status}; no cancel action possible`);
                }
            } catch (error) {
                console.error('Error canceling mint on EVM:', error);
            }
        }

        clearActiveSwap();
        this.cleanup();
    }

    cleanup() {
        this.eventWatchers.forEach(unwatch => {
            try {
                unwatch();
            } catch (error) {
                console.error('Error unwatching event:', error);
            }
        });
        this.eventWatchers = [];
    }

    async resume(savedState) {
        console.log('Resuming mint flow from state:', savedState.state);

        this.lpVault = savedState.lpVault;
        this.xmrAmount = savedState.xmrAmount;
        this.requestId = savedState.requestId;
        this.state = savedState.state;
        if (savedState.timeout) {
            this.timeout = BigInt(savedState.timeout);
        }

        // ─── Validate on-chain status before resuming ─────────────────────────
        try {
            const mintReq = await readHub('getMintRequest', [this.requestId]);
            const status = Number(mintReq.status);
            // MintStatus: 0=INVALID, 1=PENDING, 2=KEY_PROVIDED, 3=READY, 4=COMPLETED, 5=CANCELLED
            if (status === 5) {
                console.log('Mint was cancelled on-chain; aborting resume');
                const { removeActiveSwap, saveToHistory } = await import('./storage.js');
                const { showError, resetMintUI } = await import('./ui.js');
                saveToHistory({ ...savedState, status: 'Cancelled', completedAt: Date.now() });
                removeActiveSwap(this.requestId);
                showError('Mint Cancelled', 'This mint was cancelled on-chain. If you had a griefing deposit, you can withdraw it via Pending Returns.');
                resetMintUI();
                throw new Error('Mint cancelled on-chain');
            }
            if (status === 4) {
                console.log('Mint was already completed on-chain; clearing from active swaps');
                const { removeActiveSwap, saveToHistory } = await import('./storage.js');
                const { showSuccess, resetMintUI } = await import('./ui.js');
                saveToHistory({ ...savedState, status: 'Completed', completedAt: Date.now() });
                removeActiveSwap(this.requestId);
                showSuccess('Mint Completed', 'This mint was already finalized on-chain.');
                resetMintUI();
                throw new Error('Mint already completed on-chain');
            }
            if (status === 0) {
                console.log('Mint is invalid on-chain; clearing from active swaps');
                const { removeActiveSwap } = await import('./storage.js');
                const { resetMintUI } = await import('./ui.js');
                removeActiveSwap(this.requestId);
                resetMintUI();
                throw new Error('Mint is invalid on-chain');
            }
            // For statuses 1-3, proceed with resume
        } catch (error) {
            // Re-throw our own errors; ignore RPC failures and continue
            if (error.message.includes('cancelled on-chain') ||
                error.message.includes('already completed on-chain') ||
                error.message.includes('invalid on-chain')) {
                throw error;
            }
            console.warn('Could not verify on-chain mint status before resume; continuing anyway:', error.message);
        }

        this.agent = getPhantomAgent();

        // Try to restore existing seed from storage using saved publicSpendKey
        const savedPublicSpendKey = savedState.publicSpendKey;
        if (savedPublicSpendKey) {
            console.log('Restoring agent from saved publicSpendKey...');
            const restored = await this.agent.loadExistingSeed(savedPublicSpendKey);
            if (!restored) {
                throw new Error(
                    'Could not restore swap secret from browser storage. ' +
                    'You may need to sign the decryption message in your wallet, ' +
                    'or clear this swap and start fresh.'
                );
            }
            console.log('Agent restored from saved seed');
        } else {
            throw new Error(
                'No publicSpendKey found in saved swap state. ' +
                'This swap was created before auto-save was enabled. ' +
                'Please clear this swap and start a new mint.'
            );
        }

        switch (this.state) {
            case 'quote':
            case 'init':
                // Swap was initialized but not yet submitted on-chain
                // Restart from the beginning (need to get quote first)
                console.log('Restarting mint flow from', this.state, 'state...');
                await this.getQuote();
                await this.checkOracleFreshness();
                await this.initiateOnEVM();
                await this.notifyLP();
                await this.waitForLPReady();
                await this.finalize();
                break;
            case 'evm-init':
                // Transaction to initiate on EVM was started.
                // If we already have a requestId + txHash, the tx succeeded;
                // just proceed. Otherwise retry initiation.
                console.log('Resuming from evm-init state...');
                if (this.requestId && savedState.txHash) {
                    console.log('Existing requestId found, skipping re-initiation:', this.requestId);
                    this.state = 'initiated';
                    await this.notifyLP();
                } else {
                    await this.getQuote();
                    await this.checkOracleFreshness();
                    await this.initiateOnEVM();
                    await this.notifyLP();
                }
                await this.waitForLPReady();
                await this.finalize();
                break;
            case 'initiated':
            case 'awaiting-lp-key':
                await this.notifyLP();
                if (this.state === 'expired') return;
                await this.waitForLPReady();
                if (this.state === 'expired') return;
                await this.finalize();
                break;
            case 'deposit':
            case 'lp-ready':
                // Check if we have a valid deposit address, otherwise derive locally
                if (savedState.depositAddress && savedState.depositAddress.startsWith('4')) {
                    // Valid Monero address from saved state
                    this.depositAddress = savedState.depositAddress;
                    console.log('Restored Monero Deposit Address:', this.depositAddress);
                } else if (savedState.lpPublicSpendKey && savedState.lpPublicViewKey) {
                    // Derive from saved LP public keys locally
                    console.log('Deriving deposit address from saved LP public keys...');
                    this.depositAddress = await this.agent.deriveSharedMoneroAddress(savedState.lpPublicSpendKey, savedState.lpPublicViewKey);
                    console.log('Derived Monero Deposit Address:', this.depositAddress);
                } else if (savedState.lpPublicKey) {
                    // Legacy: old format with single key - fetch view key from contract
                    console.log('Legacy format detected, fetching view key from contract...');
                    const lpPublicViewKey = await readHub('lpPublicViewKeys', [this.requestId]);
                    this.depositAddress = await this.agent.deriveSharedMoneroAddress(savedState.lpPublicKey, lpPublicViewKey);
                    console.log('Derived Monero Deposit Address:', this.depositAddress);
                } else {
                    throw new Error('No deposit address or LP public keys found in saved swap state.');
                }
                
                console.log('Send exactly', this.xmrAmount, 'XMR to this address');
                
                // Update state to deposit (not lp-ready) so UI shows deposit info
                this.state = 'deposit';
                
                // Update UI to show deposit address
                updateSwapState({
                    requestId: this.requestId,
                    state: 'deposit',
                    depositAddress: this.depositAddress,
                    lpPublicSpendKey: savedState.lpPublicSpendKey,
                    lpPublicViewKey: savedState.lpPublicViewKey
                });
                
                // Force UI update by importing and calling showMintDepositInfo
                const { showMintDepositInfo } = await import('./ui.js');
                showMintDepositInfo(this.depositAddress, this.xmrAmount);
                
                await this.waitForLPReady();
                await this.finalize();
                break;
            case 'lp-verifying':
                // LP is verifying the XMR deposit, wait for them to call setMintReady
                console.log('Resuming from lp-verifying state...');
                await this.waitForLPReady();
                await this.finalize();
                break;
            case 'lp-ready':
                // LP has called setMintReady, we can finalize
                console.log('Resuming from lp-ready state...');
                await this.finalize();
                break;
            case 'finalize':
                await this.finalize();
                break;
            default:
                throw new Error('Cannot resume from state: ' + this.state);
        }
    }

    cleanup() {
        // Stop all timers
        stopTimers(this);
        
        // Unwatch events
        this.eventWatchers.forEach(unwatch => unwatch());
        this.eventWatchers = [];
    }
}
