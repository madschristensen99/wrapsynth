// Mint Flow - XMR to wsXMR (Diamond Architecture + LP Server Integration)

import { CONTRACTS, ABIS, DECIMALS, SWAP_CONFIG } from './config.js';
import { readHub, writeHub, watchContractEvent, getUserAddress } from './viemClient.js';
import { getPhantomAgent } from './phantomAgent.js';
import { getLPClient } from './lpClient.js';
import { saveActiveSwap, updateSwapState, clearActiveSwap, saveToHistory } from './storage.js';
import { keccak256, toHex, parseEther } from 'https://esm.sh/viem@2.7.0';
import { startDeadlineTimer, startStatusPolling, stopTimers } from './mintFlowTimers.js';
import { showLPVerificationStatus } from './ui.js';

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
        this.lpClient = getLPClient();
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
        await this.waitForLPReady();
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

        console.log('Getting quote from LP server...');
        
        try {
            const userAddress = getUserAddress();
            const quote = await this.lpClient.quoteMint({
                xmrAmount: this.xmrAmount,
                userAddress
            });

            console.log('Quote received:', quote);
            
            this.lpVault = quote.lp_vault || this.lpVault;
            this.griefingDeposit = BigInt(quote.griefing_deposit || '1000000000000000');
            this.wsxmrAmount = BigInt(quote.wsxmr_amount);
            
            updateSwapState({
                quote,
                griefingDeposit: this.griefingDeposit.toString(),
                wsxmrAmount: this.wsxmrAmount.toString()
            });
        } catch (error) {
            console.warn('LP server unavailable, using on-chain fallback:', error);
            
            const vault = await readHub('getVault', [this.lpVault]);
            this.griefingDeposit = vault.mintGriefingDeposit;
            
            const xmrAtomic = BigInt(Math.floor(this.xmrAmount * Math.pow(10, DECIMALS.XMR)));
            this.wsxmrAmount = await readHub('calculateWsxmrAmount', [xmrAtomic]);
        }
    }

    async initializeAgent() {
        this.state = 'init';
        updateSwapState({ state: this.state });

        console.log('Initializing Phantom Agent...');

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
            console.log('✅ Oracle prices are fresh');
        } catch (error) {
            // Prices are stale - try to update them
            console.warn('⚠️ Oracle prices are stale, attempting update...');
            try {
                await this.updatePrices();
            } catch (updateError) {
                console.warn('⚠️ Could not update prices from UI:', updateError.message);
                console.log('ℹ️ Continuing anyway - LP node should handle price updates');
                // Don't throw - the LP node will update prices
            }
        }
    }

    async updatePrices() {
        const { updateOraclePrices } = await import('./redstoneWrapper.js?v=' + Date.now());
        await updateOraclePrices();
        console.log('✅ Prices updated, continuing with mint');
    }

    async initiateOnEVM() {
        this.state = 'evm-init';
        updateSwapState({ state: this.state });

        console.log('Initiating mint on EVM...');

        const userAddress = getUserAddress();
        const xmrAmountAtomic = BigInt(Math.floor(this.xmrAmount * Math.pow(10, DECIMALS.XMR)));
        const commitment = this.agent.getCommitment();

        console.log('Initiating mint with params:', {
            lpVault: this.lpVault,
            initiator: userAddress,
            wsxmrAmount: this.wsxmrAmount.toString(),
            commitment,
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
                    commitment
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
            log.topics[0] === keccak256(toHex('MintInitiated(bytes32,address,address,address,uint256,uint256,uint256,bytes32,uint256)'))
        );

        if (mintInitiatedEvent) {
            this.requestId = mintInitiatedEvent.topics[1];
            console.log('Request ID:', this.requestId);
            
            // Save complete swap state to localStorage
            const { addOrUpdateActiveSwap } = await import('./storage.js');
            addOrUpdateActiveSwap({
                type: 'mint',
                requestId: this.requestId,
                state: 'initiated',
                lpVault: this.lpVault,
                xmrAmount: this.xmrAmount,
                wsxmrAmount: this.wsxmrAmount.toString(),
                griefingDeposit: this.griefingDeposit.toString(),
                txHash: receipt.transactionHash,
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
        
        // Wait for LP to call provideLPKey() on-chain
        const lpPublicKey = await this.waitForLPKey();
        
        console.log('✅ LP public key received:', lpPublicKey);
        
        // Get the deposit address from LP server (it computes the proper Monero address)
        console.log('Fetching deposit address from LP server...');
        try {
            const status = await this.lpClient.getMintStatus(this.requestId);
            if (status.deposit_address) {
                this.depositAddress = status.deposit_address;
                console.log('📍 Monero Deposit Address:', this.depositAddress);
                console.log('� Send exactly', this.xmrAmount, 'XMR to this address');
            } else {
                throw new Error('LP server did not provide deposit address');
            }
        } catch (error) {
            console.error('Failed to get deposit address from LP server:', error);
            throw new Error('Could not get deposit address from LP. Please try again.');
        }
        
        updateSwapState({
            requestId: this.requestId,
            state: 'deposit',
            depositAddress: this.depositAddress,
            lpPublicKey: lpPublicKey
        });

        this.state = 'deposit';
    }
    
    async waitForLPKey() {
        console.log('Polling for LP public key on-chain...');
        
        const maxAttempts = 60; // 5 minutes (5s intervals)
        
        for (let i = 0; i < maxAttempts; i++) {
            try {
                const lpPublicKey = await readHub('lpPublicKeys', [this.requestId]);
                
                if (lpPublicKey && lpPublicKey !== '0x0000000000000000000000000000000000000000000000000000000000000000') {
                    return lpPublicKey;
                }
                
                if (i % 6 === 0) { // Log every 30 seconds
                    console.log('Still waiting for LP to provide public key...');
                }
                
                await new Promise(resolve => setTimeout(resolve, 5000));
            } catch (error) {
                console.error('Error checking for LP key:', error);
                await new Promise(resolve => setTimeout(resolve, 5000));
            }
        }
        
        throw new Error('Timeout waiting for LP to provide public key. LP may be offline.');
    }

    async waitForLPReady() {
        // First, wait for user to confirm they sent the XMR
        console.log('Waiting for user to confirm XMR sent...');
        
        // Setup the confirm button
        this.setupConfirmSentButton();
        
        // Wait for user to click "I've Sent the XMR" button
        await new Promise((resolve) => {
            this.userConfirmResolve = resolve;
        });
        
        console.log('User confirmed XMR sent. Now waiting for LP to verify...');
        
        // Update UI to show LP is processing
        updateSwapState({ 
            requestId: this.requestId, 
            state: 'lp-verifying',
            message: 'LP is updating oracle prices and verifying your XMR deposit...' 
        });
        
        // Now start LP verification process
        // The state will change to 'lp-ready' when MintReady event is received

        // Start deadline countdown timer
        startDeadlineTimer(this);
        
        // Start periodic status checking (now just a placeholder)
        startStatusPolling(this);

        // Check if MintReady was already called (in case we're resuming)
        const { readHub } = await import('./viemClient.js');
        const mintRequest = await readHub('getMintRequest', [this.requestId]);
        
        if (mintRequest.status === 3) { // MintStatus.READY = 3
            console.log('Mint is already ready (status check)');
            this.state = 'lp-ready';
            updateSwapState({ requestId: this.requestId, state: this.state });
        } else {
            // Watch for on-chain MintReady event
            await new Promise((resolve, reject) => {
                const unwatch = watchContractEvent(
                    CONTRACTS.hub,
                    ABIS.hub,
                    'MintReady',
                    { requestId: this.requestId },
                    (log) => {
                        console.log('MintReady event received');
                        this.state = 'lp-ready';
                        updateSwapState({ requestId: this.requestId, state: this.state });
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

        const secret = this.agent.getSecret();

        const receipt = await writeHub('finalizeMint', [this.requestId, secret], 0n, 1000000n);

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
                await writeHub('cancelMint', [this.requestId]);
                console.log('Mint request canceled on EVM');
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
                // Transaction to initiate on EVM was started but may have failed
                // Retry from initiateOnEVM
                console.log('Resuming from evm-init state...');
                await this.getQuote();
                await this.checkOracleFreshness();
                await this.initiateOnEVM();
                await this.notifyLP();
                await this.waitForLPReady();
                await this.finalize();
                break;
            case 'initiated':
            case 'awaiting-lp-key':
                await this.notifyLP();
                await this.waitForLPReady();
                await this.finalize();
                break;
            case 'deposit':
            case 'lp-ready':
                // Check if we have a valid deposit address, otherwise fetch from LP server
                if (savedState.depositAddress && savedState.depositAddress.startsWith('4')) {
                    // Valid Monero address from saved state
                    this.depositAddress = savedState.depositAddress;
                    console.log('📍 Restored Monero Deposit Address:', this.depositAddress);
                } else {
                    // Fetch from LP server
                    console.log('Fetching deposit address from LP server...');
                    try {
                        const status = await this.lpClient.getMintStatus(this.requestId);
                        if (status.deposit_address) {
                            this.depositAddress = status.deposit_address;
                            console.log('📍 Fetched Monero Deposit Address:', this.depositAddress);
                        } else {
                            throw new Error('LP server did not provide deposit address');
                        }
                    } catch (error) {
                        console.error('Failed to get deposit address:', error);
                        throw new Error('Could not get deposit address from LP. Please try again.');
                    }
                }
                
                console.log('💡 Send exactly', this.xmrAmount, 'XMR to this address');
                
                // Update state to deposit (not lp-ready) so UI shows deposit info
                this.state = 'deposit';
                
                // Update UI to show deposit address
                updateSwapState({
                    requestId: this.requestId,
                    state: 'deposit',
                    depositAddress: this.depositAddress,
                    lpPublicKey: savedState.lpPublicKey
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
