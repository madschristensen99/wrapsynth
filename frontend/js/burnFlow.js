// Burn Flow - wsXMR to XMR (5-step Diamond Architecture)

import { CONTRACTS, ABIS, DECIMALS, SWAP_CONFIG, MONERO_CONFIG } from './config.js';
import { readHub, writeHub, writeHubUnsafe, readWsxmr, writeWsxmr, writeWsxmrUnsafe, watchContractEvent, getUserAddress } from './viemClient.js';
import { getPhantomAgent } from './phantomAgent.js';
import { saveActiveSwap, updateSwapState, clearActiveSwap, saveToHistory } from './storage.js';
import { updateBurnProgress, showBurnVerificationLoading, showBurnVerificationDetails, showBurnVerificationManual, showBurnAddressPanel, showBurnSweepProgress, showBurnSweepComplete, showBurnSweepError, showBurnKeysFallback, showBurnScanProgress, showBurnXmrFound } from './ui.js?v=3.4';
import { getMoneroRpc } from './moneroRpc.js';
import { sweepBurnOutput, getCombinedKeysForImport } from './burnSweep.js';
import { keccak256, toHex } from 'https://esm.sh/viem@2.7.0';

export class BurnFlow {
    constructor() {
        this.state = 'idle';
        this.requestId = null;
        this.agent = null;
        this.lpVault = null;
        this.wsxmrAmount = null;
        this.destination = null;
        this.secretHash = null;
        this.sharedMoneroAddress = null;
        this.privateViewKeyHex = null;
        this.eventWatchers = [];
        this.lpProposeStartTime = null;
        this.lpProposeTimeout = 1800000; // 30 minutes in ms
    }

    async start(lpVault, wsxmrAmount, destination) {
        console.log('Starting burn flow:', { lpVault, wsxmrAmount, destination });

        if (!destination || destination.length < 95) {
            throw new Error('Invalid Monero destination address');
        }

        this.lpVault = lpVault;
        this.wsxmrAmount = wsxmrAmount;
        this.destination = destination;

        await this.initializeAgent();
        await this.requestBurnOnEVM();
        await this.waitForLPProposal();
        await this.confirmMoneroLock();
        const lpSecret = await this.waitForLPFinalize();
        await this.sweepXMR(lpSecret);
        await this.complete();
    }

    async initializeAgent() {
        this.state = 'init';
        updateSwapState({ 
            type: 'burn',
            state: this.state,
            lpVault: this.lpVault,
            wsxmrAmount: this.wsxmrAmount,
            destination: this.destination
        });

        console.log('Initializing Phantom Agent...');
        
        this.agent = getPhantomAgent();
        const agentData = await this.agent.initialize('BURN', this.wsxmrAmount.toString(), this.destination);

        console.log('Agent initialized:', agentData);
        console.log('Derived Monero address for receiving XMR:', agentData.moneroAddress);

        // Store seed for resume (encrypted in browser) — same as mintFlow does
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
            publicSpendKey: publicSpendKeyHex,
            message: `Your XMR will be sent to: ${agentData.moneroAddress}`
        });
    }

    async updatePrices() {
        updateBurnProgress('evm-request', 'Updating XMR price onchain...');
        const { updateOraclePrices } = await import('./redstoneWrapper.js?v=' + Date.now());
        await updateOraclePrices();
        console.log('Oracle prices updated for burn');
    }

    async requestBurnOnEVM() {
        this.state = 'evm-request';
        updateSwapState({ state: this.state });

        console.log('Requesting burn on EVM...');

        const userAddress = getUserAddress();
        const wsxmrAmountAtomic = BigInt(Math.floor(this.wsxmrAmount * Math.pow(10, DECIMALS.wsXMR)));

        try {
            await writeWsxmr('approve', [CONTRACTS.hub, wsxmrAmountAtomic]);
        } catch (approveErr) {
            console.warn('Approve simulation failed, trying unsafe fallback:', approveErr.message);
            await writeWsxmrUnsafe('approve', [CONTRACTS.hub, wsxmrAmountAtomic]);
        }
        console.log('wsXMR approved for burn');

        // Push fresh prices before attempting requestBurn
        try {
            await this.updatePrices();
        } catch (priceErr) {
            console.warn('Could not update oracle prices:', priceErr.message);
            console.log('Continuing anyway — transaction will revert if prices are stale');
        }

        // Get the user's Ed25519 commitment and public keys for burn
        const claimCommitment = this.agent.getCommitment();
        const userPublicKey = this.agent.getPublicSpendKeyHex();
        const userViewKey = this.agent.getPublicViewKeyHex();
        console.log('Using claim commitment for burn:', claimCommitment);
        console.log('User public spend key:', userPublicKey);
        console.log('User public view key:', userViewKey);

        let receipt;
        const attemptRequestBurn = async () => {
            return await writeHub('requestBurn', [
                wsxmrAmountAtomic,
                this.lpVault,
                userAddress,
                claimCommitment,
                userPublicKey,
                userViewKey
            ]);
        };

        try {
            receipt = await attemptRequestBurn();
        } catch (error) {
            const isStalePrice = error.message && (
                error.message.includes('0x19abf40e') ||
                error.message.includes('StalePrice')
            );

            if (isStalePrice) {
                console.warn('Oracle prices stale, pushing fresh prices...');
                updateSwapState({ state: 'evm-request', message: 'Pushing fresh oracle prices...' });

                try {
                    await this.updatePrices();
                    console.log('Fresh prices pushed, retrying requestBurn...');
                } catch (updateErr) {
                    console.warn('Price update failed:', updateErr.message);
                    // Fall back to polling if proactive update fails
                    let fresh = false;
                    for (let i = 0; i < 20; i++) {
                        await new Promise(r => setTimeout(r, 3000));
                        try {
                            await readHub('getXmrPrice', []);
                            fresh = true;
                            break;
                        } catch (pollError) {
                            if (!pollError.message.includes('0x19abf40e') && !pollError.message.includes('StalePrice')) {
                                throw pollError;
                            }
                        }
                    }
                    if (!fresh) {
                        throw new Error('Oracle prices are still stale after 60 seconds. Please wait for the LP node to update prices, then try again.');
                    }
                }

                receipt = await attemptRequestBurn();
            } else if (error.message && error.message.includes('internal error')) {
                console.warn('RPC simulation failed with internal error, retrying without simulation...');
                updateSwapState({ state: 'evm-request', message: 'Submitting burn request (bypassing simulation)...' });
                receipt = await writeHubUnsafe('requestBurn', [
                    wsxmrAmountAtomic,
                    this.lpVault,
                    userAddress,
                    claimCommitment,
                    userPublicKey,
                    userViewKey
                ], 0n, 3000000n);
            } else {
                throw error;
            }
        }

        console.log('Burn requested, tx:', receipt.transactionHash);

        const burnRequestedEvent = receipt.logs.find(log => 
            log.topics[0] === keccak256(toHex('BurnRequested(bytes32,address,address,uint256,uint256,uint256,bytes32,bytes32,bytes32)'))
        );

        if (burnRequestedEvent) {
            this.requestId = burnRequestedEvent.topics[1];
            console.log('Request ID:', this.requestId);
            
            updateSwapState({
                requestId: this.requestId,
                txHash: receipt.transactionHash,
                state: 'lp-propose'
            });
        } else {
            throw new Error('Could not extract requestId from transaction');
        }

        this.state = 'lp-propose';
        updateSwapState({ requestId: this.requestId, state: this.state });
    }

    async waitForLPProposal() {
        console.log('Waiting for LP to propose secret hash and send XMR...');
        this.lpProposeStartTime = Date.now();

        // First, check if HashProposed event was already emitted in the past
        const { getPastEvents, getBlockNumber } = await import('./viemClient.js');
        const currentBlock = await getBlockNumber();
        const fromBlock = currentBlock - 1000n; // Check last ~1000 blocks (about 1.5 hours on Gnosis)
        
        console.log(`Checking for past HashProposed events from block ${fromBlock} to ${currentBlock}...`);
        const pastEvents = await getPastEvents(
            CONTRACTS.hub,
            ABIS.hub,
            'HashProposed',
            fromBlock,
            'latest',
            { requestId: this.requestId }
        );

        if (pastEvents && pastEvents.length > 0) {
            console.log('Found existing HashProposed event - LP has already sent XMR!');
            const event = pastEvents[0].args;
            this.secretHash = event.secretHash;
            const lpPublicSpendKey = event.lpPublicSpendKey;
            const lpPublicViewKey = event.lpPublicViewKey;
            
            // Derive the shared Monero address using user's actual public keys
            const { computeBurnAddress } = await import('./moneroCrypto.js');
            const userPublicKey = this.agent.getPublicSpendKeyHex();
            const userViewKey = this.agent.getPublicViewKeyHex();
            const moneroAddress = await computeBurnAddress(userPublicKey, userViewKey, lpPublicSpendKey);
            const viewKey = this.agent.getPrivateViewKeyHex();
            
            console.log('Derived burn Monero address:', moneroAddress);
            console.log('User view key for scanning:', viewKey);
            
            this.sharedMoneroAddress = moneroAddress;
            this.privateViewKeyHex = viewKey;
            
            updateSwapState({
                requestId: this.requestId,
                lpStatus: 'found',
                lpMessage: 'LP has sent XMR to the shared address',
                secretHash: this.secretHash,
                moneroAddress,
                viewKey
            });
            showBurnAddressPanel({ moneroAddress, viewKey });
            updateBurnProgress('lp-propose', '✓ LP committed — XMR sent');
            return; // Event already happened, no need to wait
        }

        console.log('No past HashProposed event found, setting up watcher for new events...');

        // Update countdown in swap state while waiting
        const countdownInterval = setInterval(() => {
            const elapsed = Date.now() - this.lpProposeStartTime;
            const remaining = Math.max(0, this.lpProposeTimeout - elapsed);
            updateSwapState({
                requestId: this.requestId,
                lpStatus: 'waiting',
                lpMessage: 'Waiting for LP to commit...',
                lpProposeRemaining: remaining
            });
        }, SWAP_CONFIG.pollInterval);

        // Polling fallback: periodically check for HashProposed events
        // in case watchContractEvent fails (RPC timeouts / rate limiting)
        let pollIntervalId = null;
        let resolved = false;
        let resolvePropose = null;

        const handleHashProposed = async (event) => {
            if (resolved) return;
            resolved = true;
            clearInterval(countdownInterval);
            if (pollIntervalId) clearInterval(pollIntervalId);

            this.secretHash = event.secretHash;
            const lpPublicSpendKey = event.lpPublicSpendKey;
            const lpPublicViewKey = event.lpPublicViewKey;

            // Derive the shared Monero address using user's actual public keys
            const { computeBurnAddress } = await import('./moneroCrypto.js');
            const userPublicKey = this.agent.getPublicSpendKeyHex();
            const userViewKey = this.agent.getPublicViewKeyHex();
            const moneroAddress = await computeBurnAddress(userPublicKey, userViewKey, lpPublicSpendKey);
            const viewKey = this.agent.getPrivateViewKeyHex();

            console.log('Derived burn Monero address:', moneroAddress);
            console.log('User view key for scanning:', viewKey);

            this.sharedMoneroAddress = moneroAddress;
            this.privateViewKeyHex = viewKey;

            updateSwapState({
                requestId: this.requestId,
                lpStatus: 'found',
                lpMessage: 'LP has sent XMR to the shared address',
                secretHash: this.secretHash,
                moneroAddress,
                viewKey
            });
            showBurnAddressPanel({ moneroAddress, viewKey });
            updateBurnProgress('lp-propose', '✓ LP committed — XMR sent');
            if (resolvePropose) resolvePropose();
        };

        // Start polling fallback every 15s
        pollIntervalId = setInterval(async () => {
            if (resolved) return;
            try {
                const { getPastEvents, getBlockNumber } = await import('./viemClient.js');
                const currentBlock = await getBlockNumber();
                const fromBlock = currentBlock - 200n;
                const events = await getPastEvents(
                    CONTRACTS.hub,
                    ABIS.hub,
                    'HashProposed',
                    fromBlock,
                    'latest',
                    { requestId: this.requestId }
                );
                if (events && events.length > 0) {
                    console.log('[Burn Poll] HashProposed event found via polling fallback!');
                    await handleHashProposed(events[0].args);
                }
            } catch (e) {
                console.warn('[Burn Poll] Polling fallback error:', e.message);
            }
        }, 15000);

        return new Promise((resolve, reject) => {
            resolvePropose = resolve;
            const unwatch = watchContractEvent(
                CONTRACTS.hub,
                ABIS.hub,
                'HashProposed',
                { requestId: this.requestId },
                async (log) => {
                    console.log('HashProposed event received - LP has sent XMR!');
                    await handleHashProposed(log.args);
                    unwatch();
                }
            );

            this.eventWatchers.push(unwatch);

            setTimeout(async () => {
                clearInterval(countdownInterval);
                if (pollIntervalId) clearInterval(pollIntervalId);
                unwatch();
                if (!resolved) {
                    // Check if burn deadline has passed — user can abort
                    try {
                        const burnReq = await readHub('getBurnRequest', [this.requestId]);
                        const status = Number(burnReq.status);
                        if (status === 1) {
                            const { showConfirmModal, showError, showSuccess } = await import('./ui.js?v=3.4');
                            const confirmed = await showConfirmModal(
                                'LP Did Not Respond',
                                '<p>The LP did not propose a secret hash in time. You can abort the burn to recover your wsXMR.</p><p>Would you like to abort now?</p>'
                            );
                            if (confirmed) {
                                try {
                                    await writeHub('abortBurn', [this.requestId]);
                                    showSuccess('Burn Aborted', 'Your wsXMR has been restored.');
                                    resolvePropose();
                                    return;
                                } catch (abortErr) {
                                    if (abortErr.message && abortErr.message.includes('DeadlineNotExpired')) {
                                        showError('Cannot Abort Yet', 'The burn deadline has not been reached on-chain yet. Please wait a bit longer.');
                                    } else {
                                        showError('Abort Failed', abortErr.message || 'Failed to abort burn');
                                    }
                                }
                            }
                        }
                    } catch (statusErr) {
                        console.error('Error checking burn status on proposal timeout:', statusErr);
                    }
                    reject(new Error('LP proposal timeout - LP did not send XMR in time'));
                }
            }, this.lpProposeTimeout);
        });
    }

    async confirmMoneroLock() {
        this.state = 'confirm-lock';
        updateSwapState({
            requestId: this.requestId,
            state: this.state,
            message: 'Verifying Monero transaction on blockchain...'
        });
        updateBurnProgress('confirm-lock', 'Scanning Monero blockchain for XMR...');
        showBurnVerificationLoading();

        console.log('LP has sent XMR to shared address:', this.sharedMoneroAddress);
        console.log('Expected amount:', this.wsxmrAmount, 'XMR');
        console.log('Secret hash:', this.secretHash);

        const expectedAtomic = BigInt(Math.floor(this.wsxmrAmount * 1e12));

        // Convert private view key (0x big-endian hex) to little-endian hex for monero-ts
        const viewKeyHex = this.privateViewKeyHex.replace(/^0x/, '').padStart(64, '0');
        const viewKeyBytes = new Uint8Array(32);
        for (let i = 0; i < 32; i++) {
            viewKeyBytes[i] = parseInt(viewKeyHex.substr(i * 2, 2), 16);
        }
        viewKeyBytes.reverse();
        const viewKeyLe = Array.from(viewKeyBytes).map(b => b.toString(16).padStart(2, '0')).join('');

        // Get restore height — start scanning from ~50 blocks before current height
        let restoreHeight = 0;
        try {
            const moneroRpc = getMoneroRpc();
            const height = await moneroRpc.getHeight();
            restoreHeight = Math.max(0, height - 50);
            console.log('Monero blockchain height:', height, 'restore from:', restoreHeight);
        } catch (e) {
            console.warn('Could not reach Monero daemon for height:', e.message);
        }

        return new Promise(async (resolve, reject) => {
            let confirmed = false;
            let viewWallet = null;
            let scanInterval = null;
            let timeoutId = null;

            const cleanup = () => {
                if (scanInterval) clearInterval(scanInterval);
                if (timeoutId) clearTimeout(timeoutId);
                const btn = document.getElementById('burn-confirm-receipt');
                const manualBtn = document.getElementById('burn-confirm-receipt-manual');
                if (btn) btn.replaceWith(btn.cloneNode(true));
                if (manualBtn) manualBtn.replaceWith(manualBtn.cloneNode(true));
            };

            const closeWallet = async () => {
                if (viewWallet) {
                    try { await viewWallet.close(); } catch (e) { /* ignore */ }
                    viewWallet = null;
                }
            };

            const onConfirm = async () => {
                if (confirmed) return;
                confirmed = true;
                cleanup();
                await closeWallet();
                updateBurnProgress('confirm-lock', 'Submitting confirmation to blockchain...');

                try {
                    let receipt;
                    try {
                        receipt = await writeHub('confirmMoneroLock', [this.requestId]);
                    } catch (simErr) {
                        if (simErr.message && simErr.message.includes('internal error')) {
                            console.warn('confirmMoneroLock simulation failed, trying unsafe fallback...');
                            receipt = await writeHubUnsafe('confirmMoneroLock', [this.requestId], 0n, 500000n);
                        } else {
                            throw simErr;
                        }
                    }
                    console.log('Monero lock confirmed on-chain, tx:', receipt.transactionHash);

                    updateSwapState({
                        requestId: this.requestId,
                        state: 'lp-finalize',
                        confirmTxHash: receipt.transactionHash,
                        message: 'Confirmed! Waiting for LP to finalize...'
                    });

                    this.state = 'lp-finalize';
                    resolve();
                } catch (error) {
                    console.error('confirmMoneroLock on-chain failed:', error);
                    updateBurnProgress('confirm-lock', 'Confirmation failed — try again');
                    confirmed = false;
                    // Show manual buttons again and re-wire for retry
                    showBurnVerificationManual();
                    const loadingEl = document.getElementById('burn-status-loading');
                    if (loadingEl) loadingEl.classList.add('hidden');
                    wireButtons();
                }
            };

            // Show verification details with what we know
            showBurnVerificationDetails({
                destination: this.sharedMoneroAddress || '',
                txHash: this.secretHash ? `Secret hash: ${this.secretHash.slice(0, 16)}...${this.secretHash.slice(-16)}` : 'Unknown',
                confirmations: restoreHeight > 0 ? `Scanning from block ${restoreHeight.toLocaleString()}` : 'Preparing scan...',
                amount: this.wsxmrAmount
            });

            // Try auto-verification with monero-ts view-only wallet
            try {
                showBurnScanProgress('Loading Monero WASM wallet for scanning...');

                let moneroTs;
                if (typeof window !== 'undefined' && window.monero_ts) {
                    moneroTs = window.monero_ts;
                } else {
                    throw new Error('Monero WASM module not loaded');
                }

                showBurnScanProgress('Creating view-only wallet to scan shared address...');
                console.log('[BurnVerify] Creating view-only wallet for address:', this.sharedMoneroAddress);

                viewWallet = await moneroTs.createWalletFull({
                    password: 'burn-verify-tmp',
                    networkType: moneroTs.MoneroNetworkType.MAINNET,
                    primaryAddress: this.sharedMoneroAddress,
                    privateViewKey: viewKeyLe,
                    serverUri: MONERO_CONFIG.rpcUrl,
                    restoreHeight: restoreHeight,
                });

                showBurnScanProgress('Syncing wallet to scan for incoming XMR...');
                await viewWallet.startSyncing();

                // Poll for incoming transactions
                let scanStartTime = Date.now();
                const scanTimeout = 180000; // 3 minutes

                const checkForXmr = async () => {
                    if (confirmed) return;
                    const elapsed = Date.now() - scanStartTime;
                    if (elapsed > scanTimeout) {
                        console.warn('[BurnVerify] Auto-scan timeout, falling back to manual confirm');
                        await closeWallet();
                        showBurnVerificationManual();
                        updateBurnProgress('confirm-lock', 'Auto-scan timeout — confirm manually');
                        return;
                    }

                    try {
                        const syncHeight = await viewWallet.getSyncHeight();
                        const daemonHeight = await viewWallet.getDaemonHeight();
                        const balance = await viewWallet.getBalance();

                        console.log(`[BurnVerify] Sync: ${syncHeight}/${daemonHeight}, balance: ${balance.toString()}`);

                        if (balance.toString() !== '0') {
                            // Found incoming XMR!
                            const unlockedBalance = await viewWallet.getUnlockedBalance();
                            const txs = await viewWallet.getTxs();
                            let confirmations = 0;
                            let receivedAmount = 0n;

                            for (const tx of txs) {
                                if (tx.getIncomingAmount && tx.getIncomingAmount) {
                                    const amt = BigInt(tx.getIncomingAmount().toString());
                                    if (amt > 0n) receivedAmount += amt;
                                }
                                if (tx.getNumConfirmations && tx.getNumConfirmations()) {
                                    confirmations = Math.max(confirmations, tx.getNumConfirmations());
                                }
                            }

                            console.log(`[BurnVerify] XMR found! Amount: ${receivedAmount}, confirmations: ${confirmations}`);

                            const xmrAmount = Number(receivedAmount) / 1e12;
                            showBurnXmrFound(xmrAmount, confirmations);
                            updateBurnProgress('confirm-lock', `✓ XMR verified: ${xmrAmount} XMR (${confirmations} confs)`);
                            updateSwapState({
                                requestId: this.requestId,
                                state: this.state,
                                message: `XMR verified: ${xmrAmount} XMR received`
                            });

                            await closeWallet();

                            // Auto-confirm after short delay so user sees the success state
                            setTimeout(() => onConfirm(), 1500);
                            return;
                        }

                        // Still syncing or no XMR yet
                        showBurnScanProgress(`Scanning... ${syncHeight}/${daemonHeight} blocks synced`);
                        updateBurnProgress('confirm-lock', `Scanning Monero... ${syncHeight}/${daemonHeight}`);
                    } catch (e) {
                        console.warn('[BurnVerify] Scan check error:', e.message);
                        showBurnScanProgress(`Scanning... (retrying)`);
                    }
                };

                // Check every 5 seconds
                scanInterval = setInterval(checkForXmr, 5000);

                // Initial check after 3 seconds (let sync start)
                setTimeout(checkForXmr, 3000);

                // Overall timeout
                timeoutId = setTimeout(() => {
                    if (!confirmed) {
                        console.warn('[BurnVerify] Overall timeout, falling back to manual');
                        clearInterval(scanInterval);
                        closeWallet().then(() => {
                            showBurnVerificationManual();
                            updateBurnProgress('confirm-lock', 'Auto-scan timeout — confirm manually');
                        });
                    }
                }, scanTimeout + 10000);

            } catch (wasmError) {
                console.warn('[BurnVerify] View-only wallet failed, falling back to manual:', wasmError.message);
                await closeWallet();
                showBurnVerificationManual();
                updateBurnProgress('confirm-lock', 'Confirm receipt of XMR to proceed...');
            }

            // Wire up confirm button and manual verify button
            const wireButtons = () => {
                const btn = document.getElementById('burn-confirm-receipt');
                const manualBtn = document.getElementById('burn-confirm-receipt-manual');
                if (btn) btn.addEventListener('click', onConfirm);
                if (manualBtn) manualBtn.addEventListener('click', () => {
                    const addr = this.sharedMoneroAddress || '';
                    if (addr) {
                        window.open(`https://xmrchain.net/search?value=${addr}`, '_blank');
                    }
                });
            };
            wireButtons();
        });
    }

    async waitForLPFinalize() {
        console.log('Waiting for LP to finalize burn...');

        // First, check if BurnFinalized event was already emitted in the past
        const { getPastEvents, getBlockNumber } = await import('./viemClient.js');
        const currentBlock = await getBlockNumber();
        const fromBlock = currentBlock - 1000n; // Check last ~1000 blocks
        
        console.log(`Checking for past BurnFinalized events from block ${fromBlock} to ${currentBlock}...`);
        const pastEvents = await getPastEvents(
            CONTRACTS.hub,
            ABIS.hub,
            'BurnFinalized',
            fromBlock,
            'latest',
            { requestId: this.requestId }
        );

        if (pastEvents && pastEvents.length > 0) {
            console.log('Found existing BurnFinalized event!');
            const secret = pastEvents[0].args.secret;
            console.log('Secret revealed:', secret);
            return secret; // Event already happened, no need to wait
        }

        console.log('No past BurnFinalized event found, setting up watcher for new events...');

        let finalizeResolved = false;

        return new Promise((resolve, reject) => {
            let finalizePollId = null;

            const handleFinalized = (secret) => {
                if (finalizeResolved) return null;
                finalizeResolved = true;
                if (finalizePollId) clearInterval(finalizePollId);
                console.log('Secret revealed:', secret);
                return secret;
            };

            const unwatch = watchContractEvent(
                CONTRACTS.hub,
                ABIS.hub,
                'BurnFinalized',
                { requestId: this.requestId },
                (log) => {
                    console.log('BurnFinalized event received');
                    const secret = handleFinalized(log.args.secret);
                    if (secret !== null) {
                        unwatch();
                        resolve(secret);
                    }
                }
            );

            this.eventWatchers.push(unwatch);

            // Polling fallback every 15s
            finalizePollId = setInterval(async () => {
                if (finalizeResolved) return;
                try {
                    const { getPastEvents, getBlockNumber } = await import('./viemClient.js');
                    const currentBlock = await getBlockNumber();
                    const fromBlock = currentBlock - 200n;
                    const events = await getPastEvents(
                        CONTRACTS.hub,
                        ABIS.hub,
                        'BurnFinalized',
                        fromBlock,
                        'latest',
                        { requestId: this.requestId }
                    );
                    if (events && events.length > 0) {
                        console.log('[Burn Poll] BurnFinalized event found via polling fallback!');
                        const secret = handleFinalized(events[0].args.secret);
                        if (secret !== null) {
                            unwatch();
                            resolve(secret);
                        }
                    }
                } catch (e) {
                    console.warn('[Burn Poll] Finalize polling fallback error:', e.message);
                }
            }, 15000);

            setTimeout(async () => {
                if (finalizePollId) clearInterval(finalizePollId);
                unwatch();
                if (!finalizeResolved) {
                    // Check on-chain status to offer the correct recovery path
                    try {
                        const burnReq = await readHub('getBurnRequest', [this.requestId]);
                        const status = Number(burnReq.status);
                        // BurnStatus: 0=INVALID, 1=REQUESTED, 2=PROPOSED, 3=COMMITTED, 4=COMPLETED, 5=SLASHED, 6=CANCELLED

                        if (status === 3) {
                            // COMMITTED — LP didn't finalize, user can claim slashed collateral
                            const { showError, showConfirmModal } = await import('./ui.js?v=3.4');
                            const confirmed = await showConfirmModal(
                                'LP Failed to Finalize',
                                '<p>The LP did not finalize the burn in time. You can claim slashed collateral (par value + reward) from the LP\'s vault.</p><p>Would you like to claim now?</p>'
                            );
                            if (confirmed) {
                                try {
                                    await this.claimSlashed();
                                    const { showSuccess } = await import('./ui.js?v=3.4');
                                    showSuccess('Slashed Collateral Claimed', 'Your sDAI has been queued. Withdraw it via Pending Returns.');
                                    resolve(null);
                                    return;
                                } catch (claimErr) {
                                    if (claimErr.message && claimErr.message.includes('DeadlineNotExpired')) {
                                        showError('Cannot Claim Yet', 'The grace period has not expired. Please wait a bit longer and try cancelling again.');
                                    } else {
                                        showError('Claim Failed', claimErr.message || 'Failed to claim slashed collateral');
                                    }
                                }
                            }
                            reject(new Error('LP finalize timeout — slashed collateral available to claim'));
                            return;
                        } else if (status === 1) {
                            // REQUESTED — LP never proposed, user can abort
                            const { showConfirmModal } = await import('./ui.js?v=3.4');
                            const confirmed = await showConfirmModal(
                                'LP Did Not Respond',
                                '<p>The LP did not respond to your burn request in time. You can abort the burn to recover your wsXMR.</p><p>Would you like to abort now?</p>'
                            );
                            if (confirmed) {
                                try {
                                    await writeHub('abortBurn', [this.requestId]);
                                    const { showSuccess } = await import('./ui.js?v=3.4');
                                    showSuccess('Burn Aborted', 'Your wsXMR has been restored.');
                                    resolve(null);
                                    return;
                                } catch (abortErr) {
                                    if (abortErr.message && abortErr.message.includes('DeadlineNotExpired')) {
                                        const { showError } = await import('./ui.js?v=3.4');
                                        showError('Cannot Abort Yet', 'The burn deadline has not been reached yet.');
                                    } else {
                                        throw abortErr;
                                    }
                                }
                            }
                            reject(new Error('LP finalize timeout — burn can be aborted'));
                            return;
                        } else if (status === 2) {
                            // PROPOSED — LP proposed but didn't follow through, anyone can resolve
                            const { showConfirmModal } = await import('./ui.js?v=3.4');
                            const confirmed = await showConfirmModal(
                                'LP Proposal Expired',
                                '<p>The LP proposed a secret hash but did not lock XMR in time. You can resolve this to recover your wsXMR.</p><p>Would you like to resolve now?</p>'
                            );
                            if (confirmed) {
                                try {
                                    await writeHub('resolveDeclinedProposal', [this.requestId]);
                                    const { showSuccess } = await import('./ui.js?v=3.4');
                                    showSuccess('Burn Resolved', 'Your wsXMR has been restored.');
                                    resolve(null);
                                    return;
                                } catch (resolveErr) {
                                    if (resolveErr.message && resolveErr.message.includes('DeadlineNotExpired')) {
                                        const { showError } = await import('./ui.js?v=3.4');
                                        showError('Cannot Resolve Yet', 'The burn deadline has not been reached yet.');
                                    } else {
                                        throw resolveErr;
                                    }
                                }
                            }
                            reject(new Error('LP finalize timeout — proposal can be resolved'));
                            return;
                        }
                    } catch (statusErr) {
                        console.error('Error checking burn status on timeout:', statusErr);
                    }
                    reject(new Error('LP finalize timeout'));
                }
            }, 1800000);
        });
    }

    async sweepXMR(lpSecret) {
        this.state = 'sweeping';
        this._lastLpSecret = lpSecret; // Store for retry
        updateSwapState({ state: this.state, message: 'Claiming XMR from shared address...' });
        showBurnSweepProgress('Preparing to claim XMR...');

        const userSecret = this.agent.getSecret();
        const userViewKey = this.agent.getPrivateViewKeyHex();

        // Get restore height from when the burn was proposed
        let restoreHeight = 0;
        try {
            const moneroRpc = getMoneroRpc();
            restoreHeight = await moneroRpc.getHeight() - 50; // Start 50 blocks before current
        } catch (e) {
            console.warn('Could not get Monero height for restore:', e.message);
        }

        // Set up retry listener (cleaned up on success or new attempt)
        const retryHandler = async () => {
            window.removeEventListener('burn-sweep-retry', retryHandler);
            await this.sweepXMR(this._lastLpSecret);
        };
        window.addEventListener('burn-sweep-retry', retryHandler);

        try {
            const result = await sweepBurnOutput({
                userSecretHex: userSecret,
                lpSecretHex: lpSecret,
                userViewKeyHex: userViewKey,
                destination: this.destination,
                restoreHeight,
                onProgress: (msg) => {
                    showBurnSweepProgress(msg);
                    updateSwapState({ state: 'sweeping', message: msg });
                }
            });

            if (result.swept) {
                window.removeEventListener('burn-sweep-retry', retryHandler);
                showBurnSweepComplete(result.txHashes[0], Number(result.amount) / 1e12);
                updateSwapState({
                    state: 'swept',
                    sweepTxHash: result.txHashes[0],
                    sweepAmount: result.amount
                });
            } else {
                throw new Error('Sweep did not complete');
            }
        } catch (sweepErr) {
            console.error('Burn sweep failed:', sweepErr);
            showBurnSweepError(sweepErr.message);

            // Show fallback: let user copy keys for manual import
            const keys = getCombinedKeysForImport(userSecret, lpSecret, userViewKey);
            showBurnKeysFallback(keys, this.destination);

            // Save state so user can retry later
            updateSwapState({
                state: 'sweep-failed',
                lpSecret: lpSecret,
                message: 'Sweep failed. Use copied keys to claim XMR manually, or retry.'
            });
            throw sweepErr;
        }
    }

    async complete() {
        this.state = 'completed';
        
        const swapData = {
            type: 'burn',
            requestId: this.requestId,
            lpVault: this.lpVault,
            wsxmrAmount: this.wsxmrAmount,
            destination: this.destination,
            state: 'completed',
            timestamp: Date.now()
        };
        
        saveToHistory(swapData);
        clearActiveSwap();
        this.cleanup();
        
        console.log('Burn flow completed successfully!');
    }

    async claimSlashed() {
        console.log('Claiming slashed collateral...');

        try {
            const receipt = await writeHub('claimSlashedCollateral', [this.requestId]);
            console.log('Slashed collateral claimed, tx:', receipt.transactionHash);
        } catch (error) {
            console.error('Error claiming slashed collateral:', error);
            throw error;
        }
    }

    async cancel() {
        console.log('Canceling burn...');

        if (this.requestId) {
            try {
                const burnReq = await readHub('getBurnRequest', [this.requestId]);
                const status = Number(burnReq.status);
                // BurnStatus: 0=INVALID, 1=REQUESTED, 2=PROPOSED, 3=COMMITTED, 4=COMPLETED, 5=SLASHED, 6=CANCELLED

                if (status === 1) {
                    // REQUESTED — user can abort after deadline
                    try {
                        await writeHub('abortBurn', [this.requestId]);
                        console.log('Burn aborted on EVM');
                    } catch (err) {
                        if (err.message && err.message.includes('DeadlineNotExpired')) {
                            const { showError } = await import('./ui.js?v=3.4');
                            showError('Cannot Cancel Yet', 'The burn deadline has not been reached yet. Please wait until the timeout expires.');
                            return;
                        }
                        throw err;
                    }
                } else if (status === 2) {
                    // PROPOSED — anyone can resolve after deadline
                    try {
                        await writeHub('resolveDeclinedProposal', [this.requestId]);
                        console.log('Burn proposal resolved (declined) on EVM');
                    } catch (err) {
                        if (err.message && err.message.includes('DeadlineNotExpired')) {
                            const { showError } = await import('./ui.js?v=3.4');
                            showError('Cannot Cancel Yet', 'The burn deadline has not been reached yet. Please wait until the timeout expires.');
                            return;
                        }
                        throw err;
                    }
                } else if (status === 3) {
                    // COMMITTED — user can claim slashed collateral after deadline + grace
                    try {
                        await writeHub('claimSlashedCollateral', [this.requestId]);
                        console.log('Slashed collateral claimed on EVM');
                    } catch (err) {
                        if (err.message && err.message.includes('DeadlineNotExpired')) {
                            const { showError } = await import('./ui.js?v=3.4');
                            showError('Cannot Claim Yet', 'The burn deadline plus grace period has not been reached yet. Please wait a bit longer.');
                            return;
                        }
                        throw err;
                    }
                } else if (status === 4) {
                    // COMPLETED — nothing to cancel
                    console.log('Burn already completed');
                } else if (status === 5 || status === 6) {
                    // SLASHED or CANCELLED — claim any pending returns
                    await writeHub('withdrawReturns', ['0x0000000000000000000000000000000000000000']);
                    console.log('Pending returns withdrawn');
                } else {
                    console.warn(`Burn status is ${status}; no cancel action possible`);
                }
            } catch (error) {
                console.error('Error canceling burn on EVM:', error);
                const { showError } = await import('./ui.js?v=3.4');
                showError('Cancel Failed', error.message || 'Failed to cancel burn');
                return;
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
        console.log('Resuming burn flow from state:', savedState.state);

        this.lpVault = savedState.lpVault;
        this.wsxmrAmount = savedState.wsxmrAmount;
        this.destination = savedState.destination;
        this.requestId = savedState.requestId;
        this.state = savedState.state;

        this.agent = getPhantomAgent();
        await this.agent.initialize('BURN', this.wsxmrAmount.toString(), this.destination);

        // Restore shared address and view key if available from saved state
        if (savedState.moneroAddress) this.sharedMoneroAddress = savedState.moneroAddress;
        if (savedState.viewKey) this.privateViewKeyHex = savedState.viewKey;

        switch (this.state) {
            case 'evm-request':
            case 'lp-propose':
                await this.waitForLPProposal();
                await this.confirmMoneroLock();
                const lpSecret1 = await this.waitForLPFinalize();
                await this.sweepXMR(lpSecret1);
                await this.complete();
                break;
            case 'confirm-lock':
                await this.confirmMoneroLock();
                const lpSecret2 = await this.waitForLPFinalize();
                await this.sweepXMR(lpSecret2);
                await this.complete();
                break;
            case 'lp-finalize':
                const lpSecret3 = await this.waitForLPFinalize();
                await this.sweepXMR(lpSecret3);
                await this.complete();
                break;
            case 'sweeping':
            case 'sweep-failed':
                // Re-derive LP secret from on-chain event
                const { getPastEvents, getBlockNumber } = await import('./viemClient.js');
                const currentBlock = await getBlockNumber();
                const fromBlock = currentBlock - 10000n;
                const pastEvents = await getPastEvents(
                    CONTRACTS.hub,
                    ABIS.hub,
                    'BurnFinalized',
                    fromBlock,
                    'latest',
                    { requestId: this.requestId }
                );
                if (pastEvents && pastEvents.length > 0) {
                    const lpSecret = pastEvents[0].args.secret;
                    await this.sweepXMR(lpSecret);
                    await this.complete();
                } else {
                    throw new Error('Cannot resume: BurnFinalized event not found');
                }
                break;
            default:
                throw new Error('Cannot resume from state: ' + this.state);
        }
    }
}
