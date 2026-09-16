/**
 * Burn Flow — wsXMR to XMR (5-step Diamond Architecture)
 *
 * State machine that orchestrates the full burn lifecycle:
 *   idle → init → evm-request → lp-propose → confirm-lock → lp-finalize → sweep → completed
 *
 * Each step maps to an on-chain state transition in BurnFacet.sol:
 *   requestBurn → proposeHash → confirmMoneroLock → finalizeBurn
 *
 * The user's wsXMR is burned at request time. The LP sends XMR to a shared Monero address
 * and proposes a secret hash. The user verifies the XMR on-chain, confirms the lock, then
 * the LP reveals their secret to finalize. The user combines secrets to sweep XMR.
 */

import { CONTRACTS, ABIS, DECIMALS, SWAP_CONFIG, MONERO_CONFIG } from './config.js';
import { readHub, writeHub, writeHubUnsafe, readWsxmr, writeWsxmr, writeWsxmrUnsafe, watchContractEvent, getUserAddress, getPublicClient } from './viemClient.js';
import { getPhantomAgent } from './phantomAgent.js';
import { derivePerBurnKeySet } from './seedManager.js?v=3.3';
import { saveActiveSwap, updateSwapState, clearActiveSwap, saveToHistory } from './storage.js';
import { updateBurnProgress, showBurnVerificationLoading, showBurnVerificationDetails, showBurnVerificationManual, showBurnAddressPanel, showBurnSweepProgress, showBurnSweepComplete, showBurnSweepError, showBurnKeysFallback, showBurnKeysOption, hideBurnKeysOption, showBurnScanProgress, showBurnXmrFound, updateCancelBurnButton } from './ui.js?v=3.4';
import { getMoneroRpc } from './moneroRpc.js';
import { sweepBurnOutput, getCombinedKeysForImport, toLeHex } from './burnSweep.js';
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
        this.lpProposeTimeout = 3600000; // fallback 60 min, overridden by on-chain deadline
        this.deadlineBlock = null;        // on-chain deadline block number
        this.moneroTxHash = null;         // Monero tx hash found by auto-scan
        this.perBurnKeySet = null;       // Per-burn Ed25519 key set (unique per burn)
        this.burnNonce = null;           // Local nonce for per-burn key derivation
    }

    /**
     * Run the complete burn flow from start to finish.
     * Orchestrates: agent init → EVM request → LP proposal wait → Monero lock confirm →
     * LP finalize wait → XMR sweep → complete.
     * @param {string} lpVault - LP vault address to burn against
     * @param {number} wsxmrAmount - Amount of wsXMR to burn (human-readable)
     * @param {string} destination - Monero destination address for receiving XMR
     */
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
        
        // Burn is functionally complete — fire animation and banner now
        const { showBurnComplete } = await import('./ui.js?v=' + Date.now());
        showBurnComplete(this.wsxmrAmount);
        
        // Sweep is a post-burn claim step — don't let failures block completion
        await this.sweepXMR(lpSecret);
        await this.complete();
    }

    /**
     * Initialize the PhantomAgent for BURN mode — generates Ed25519 keys and derives
     * the Monero address where the user will receive XMR from the LP.
     * Stores the seed in encrypted browser storage for crash recovery.
     */
    async initializeAgent() {
        this.state = 'init';
        updateSwapState({ 
            type: 'burn',
            state: this.state,
            lpVault: this.lpVault,
            wsxmrAmount: this.wsxmrAmount,
            destination: this.destination
        });

        updateBurnProgress('init', 'Generating Ed25519 keys and deriving Monero address...');
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

        // Derive per-burn key set — each burn gets a unique private spend key
        // so revealing userSecret on-chain in resolveDeclinedProposal only
        // compromises that specific burn, not all burns.
        this.burnNonce = _getNextBurnNonce();
        this.perBurnKeySet = derivePerBurnKeySet(this.agent.seed, this.burnNonce);
        const perBurnPubHex = '0x' + Array.from(this.perBurnKeySet.publicSpendKey)
            .map(b => b.toString(16).padStart(2, '0')).join('');
        console.log('[Burn] Per-burn key set derived (nonce=' + this.burnNonce + ')');
        console.log('[Burn] Per-burn public spend key:', perBurnPubHex);
        console.log('[Burn] Per-burn commitment:', this.perBurnKeySet.commitment);

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

    /**
     * Call requestBurn on the Hub — approves wsXMR, pushes fresh oracle prices,
     * submits the burn request with the user's Ed25519 commitment and public keys.
     * Extracts the requestId from the BurnRequested event. Handles stale price retries
     * and RPC simulation failures with unsafe fallback.
     */
    async requestBurnOnEVM() {
        this.state = 'evm-request';
        updateSwapState({ state: this.state });

        console.log('Requesting burn on EVM...');

        const userAddress = getUserAddress();
        const wsxmrAmountAtomic = BigInt(Math.floor(this.wsxmrAmount * Math.pow(10, DECIMALS.wsXMR)));

        updateBurnProgress('evm-request', 'Step 1/3: Approving wsXMR spend (check wallet)...');
        try {
            await writeWsxmr('approve', [CONTRACTS.hub, wsxmrAmountAtomic]);
        } catch (approveErr) {
            console.warn('Approve simulation failed, trying unsafe fallback:', approveErr.message);
            await writeWsxmrUnsafe('approve', [CONTRACTS.hub, wsxmrAmountAtomic]);
        }
        console.log('wsXMR approved for burn');
        updateBurnProgress('evm-request', '✓ wsXMR approved — updating oracle price...');

        // Push fresh prices before attempting requestBurn
        try {
            updateBurnProgress('evm-request', 'Step 2/3: Updating oracle price (check wallet)...');
            await this.updatePrices();
            updateBurnProgress('evm-request', '✓ Oracle updated — step 3/3: submitting burn request (check wallet)...');
        } catch (priceErr) {
            console.warn('Could not update oracle prices:', priceErr.message);
            console.log('Continuing anyway — transaction will revert if prices are stale');
            updateBurnProgress('evm-request', 'Step 3/3: Submitting burn request (check wallet)...');
        }

        // Use per-burn key set (not the agent's master keys) so each burn has a unique secret
        const claimCommitment = this.perBurnKeySet.commitment;
        const userPublicKey = '0x' + Array.from(this.perBurnKeySet.publicSpendKey)
            .map(b => b.toString(16).padStart(2, '0')).join('');
        const userViewKey = '0x' + Array.from(this.perBurnKeySet.publicViewKey)
            .map(b => b.toString(16).padStart(2, '0')).join('');
        console.log('Using per-burn commitment for burn:', claimCommitment);
        console.log('Per-burn public spend key:', userPublicKey);
        console.log('Per-burn public view key:', userViewKey);

        let receipt;
        const attemptRequestBurn = async () => {
            updateBurnProgress('evm-request', 'Step 3/3: Submitting burn request (check wallet)...');
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
                updateBurnProgress('evm-request', 'Oracle prices stale — updating prices (check wallet)...');

                try {
                    await this.updatePrices();
                    updateBurnProgress('evm-request', '✓ Fresh prices pushed — retrying burn request...');
                    console.log('Fresh prices pushed, retrying requestBurn...');
                } catch (updateErr) {
                    console.warn('Price update failed:', updateErr.message);
                    updateBurnProgress('evm-request', 'Waiting for fresh oracle prices...');
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
                    updateBurnProgress('evm-request', '✓ Fresh prices available — retrying burn request...');
                }

                receipt = await attemptRequestBurn();
            } else if (error.message && error.message.includes('internal error')) {
                console.warn('RPC simulation failed with internal error, retrying without simulation...');
                updateBurnProgress('evm-request', 'Submitting burn request (bypassing simulation, check wallet)...');
                receipt = await writeHubUnsafe('requestBurn', [
                    wsxmrAmountAtomic,
                    this.lpVault,
                    userAddress,
                    claimCommitment,
                    userPublicKey,
                    userViewKey
                ], 0n, 3000000n);
            } else if (error.message && (error.message.includes('0x9f7cb3a4') || error.message.includes('PendingMintLock'))) {
                throw new Error('The LP vault has pending mint requests that must be resolved first. Please wait for the LP to finalize or cancel the pending mints, then try again.');
            } else if (error.message && (error.message.includes('0xa72c1aea') || error.message.includes('InsufficientCollateral'))) {
                throw new Error('The LP vault does not have enough free collateral to process this burn. Try a smaller amount or wait for the LP to add more collateral.');
            } else {
                throw error;
            }
        }

        console.log('Burn requested, tx:', receipt.transactionHash);
        updateBurnProgress('evm-request', `✓ Burn submitted — waiting for LP to respond...`);

        const burnRequestedEvent = receipt.logs.find(log => 
            log.topics[0] === keccak256(toHex('BurnRequested(bytes32,address,address,uint256,uint256,uint256,bytes32,bytes32,bytes32)'))
        );

        if (burnRequestedEvent) {
            this.requestId = burnRequestedEvent.topics[1];
            console.log('Request ID:', this.requestId);
            
            // Store requestId -> burnNonce mapping for recovery
            _storeBurnNonceMapping(this.requestId, this.burnNonce);
            
            updateSwapState({
                requestId: this.requestId,
                txHash: receipt.transactionHash,
                state: 'lp-propose',
                burnNonce: this.burnNonce
            });
        } else {
            throw new Error('Could not extract requestId from transaction');
        }

        this.state = 'lp-propose';
        updateSwapState({ requestId: this.requestId, state: this.state });
    }

    /**
     * Wait for the LP to call proposeHash on-chain (indicates LP has sent XMR to the
     * shared Monero address). Checks for past HashProposed events (resume support),
     * then watches for new events with a polling fallback. On event, derives the shared
     * Monero address and shows it to the user. Offers abort option on timeout.
     */
    async waitForLPProposal() {
        console.log('Waiting for LP to propose secret hash and send XMR...');
        this.lpProposeStartTime = Date.now();

        // Fetch on-chain deadline to sync countdown with contract state
        try {
            const burnReq = await readHub('getBurnRequest', [this.requestId]);
            this.deadlineBlock = Number(burnReq.deadline);
            const currentBlock = Number(await getPublicClient().getBlockNumber());
            const blocksRemaining = Math.max(0, this.deadlineBlock - currentBlock);
            this.lpProposeTimeout = blocksRemaining * 5000; // 5s per block on Gnosis
            console.log(`[Burn] On-chain deadline: block ${this.deadlineBlock}, current: ${currentBlock}, ${blocksRemaining} blocks remaining (~${Math.ceil(this.lpProposeTimeout / 60000)} min)`);
        } catch (err) {
            console.warn('[Burn] Could not fetch on-chain deadline, using fallback:', err.message);
        }

        // Helper to derive and show the burn address from LP public keys
        const deriveAndShowAddress = async (secretHash, lpPublicSpendKey, lpPublicViewKey) => {
            const { computeBurnAddress } = await import('./moneroCrypto.js');
            const userPublicKey = '0x' + Array.from(this.perBurnKeySet.publicSpendKey)
                .map(b => b.toString(16).padStart(2, '0')).join('');
            const userViewKey = '0x' + Array.from(this.perBurnKeySet.publicViewKey)
                .map(b => b.toString(16).padStart(2, '0')).join('');
            const moneroAddress = await computeBurnAddress(userPublicKey, userViewKey, lpPublicSpendKey);
            const viewKey = '0x' + this.perBurnKeySet.privateViewKey.toString(16).padStart(64, '0');

            console.log('Derived burn Monero address:', moneroAddress);
            console.log('User view key for scanning:', viewKey);

            this.secretHash = secretHash;
            this.sharedMoneroAddress = moneroAddress;
            this.privateViewKeyHex = viewKey;

            // Fetch Monero block height now so confirmMoneroLock can use a tight restore height
            try {
                const moneroRpc = getMoneroRpc();
                const moneroHeight = await moneroRpc.getHeight();
                this.moneroProposeHeight = moneroHeight;
                console.log('[Burn] Monero height at LP propose:', moneroHeight);
            } catch (e) {
                console.warn('[Burn] Could not fetch Monero height at propose time:', e.message);
            }

            updateSwapState({
                requestId: this.requestId,
                lpStatus: 'found',
                lpMessage: 'LP has sent XMR to the shared address',
                secretHash,
                moneroAddress,
                viewKey,
                moneroProposeHeight: this.moneroProposeHeight || null
            });
            // Display the view key in little-endian (Monero wallet-compatible) format
            showBurnAddressPanel({ moneroAddress, viewKey: toLeHex(viewKey) });
            updateBurnProgress('lp-propose', '✓ LP committed — XMR sent');

            // Pre-warm monero-ts WASM module so it's ready when confirmMoneroLock runs
            if (typeof window !== 'undefined' && window.monero_ts && !window._moneroTsWarmed) {
                window._moneroTsWarmed = true;
                try {
                    if (window.monero_ts.MoneroNetworkType) {
                        console.log('[Burn] Pre-warming monero-ts WASM module');
                    }
                } catch {}
            }
        };

        // Helper to check on-chain burn status and derive address from contract data
        // This bypasses flaky eth_getLogs by reading contract state directly
        const checkOnChainProposed = async () => {
            try {
                const burnReq = await readHub('getBurnRequest', [this.requestId]);
                const status = Number(burnReq.status);
                // BurnStatus: 0=INVALID, 1=REQUESTED, 2=PROPOSED, 3=COMMITTED, 4=COMPLETED, 5=CANCELLED, 6=SLASHED
                if (status >= 2) {
                    console.log(`[Burn] On-chain status is ${status} (>=PROPOSED), reading LP keys from contract...`);
                    const lpPublicSpendKey = await readHub('burnLpPublicKeys', [this.requestId]);
                    const lpPublicViewKey = await readHub('burnLpPublicViewKeys', [this.requestId]);
                    if (lpPublicSpendKey && lpPublicSpendKey !== '0x0000000000000000000000000000000000000000000000000000000000000000') {
                        console.log('[Burn] Got LP public keys from contract, deriving address...');
                        await deriveAndShowAddress(burnReq.secretHash, lpPublicSpendKey, lpPublicViewKey);
                        return true;
                    }
                }
            } catch (e) {
                console.warn('[Burn] On-chain status check failed:', e.message);
            }
            return false;
        };

        // First, try checking on-chain status directly (most reliable)
        if (await checkOnChainProposed()) return;

        // Second, try past events check (may fail on flaky RPCs)
        try {
            const { getPastEvents, getBlockNumber } = await import('./viemClient.js');
            const currentBlock = await getBlockNumber();
            const fromBlock = currentBlock - 1000n;

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
                await deriveAndShowAddress(event.secretHash, event.lpPublicSpendKey, event.lpPublicViewKey);
                return;
            }
        } catch (e) {
            console.warn('[Burn] Past events check failed (RPC issue), falling back to polling:', e.message);
        }

        console.log('No past HashProposed event found, setting up watcher + polling fallback...');

        // Update countdown in swap state and UI while waiting
        const countdownInterval = setInterval(() => {
            const elapsed = Date.now() - this.lpProposeStartTime;
            const remaining = Math.max(0, this.lpProposeTimeout - elapsed);
            updateSwapState({
                requestId: this.requestId,
                lpStatus: 'waiting',
                lpMessage: 'Waiting for LP to commit...',
                lpProposeRemaining: remaining
            });
            const mins = Math.floor(remaining / 60000);
            const secs = Math.floor((remaining % 60000) / 1000);
            if (remaining > 0) {
                updateBurnProgress('lp-propose', `Waiting for LP to send XMR... ${mins}:${secs.toString().padStart(2, '0')} remaining`);
            } else {
                updateBurnProgress('lp-propose', 'LP response overdue — still waiting...');
            }
        }, SWAP_CONFIG.pollInterval);

        let pollIntervalId = null;
        let resolved = false;
        let resolvePropose = null;

        const handleHashProposed = async (event) => {
            if (resolved) return;
            resolved = true;
            clearInterval(countdownInterval);
            if (pollIntervalId) clearInterval(pollIntervalId);

            await deriveAndShowAddress(event.secretHash, event.lpPublicSpendKey, event.lpPublicViewKey);
            if (resolvePropose) resolvePropose();
        };

        // Polling fallback every 10s: try on-chain status check first, then event query
        pollIntervalId = setInterval(async () => {
            if (resolved) return;

            // Method 1: Direct on-chain status check (reliable, no eth_getLogs)
            if (await checkOnChainProposed()) {
                resolved = true;
                clearInterval(countdownInterval);
                if (pollIntervalId) clearInterval(pollIntervalId);
                if (resolvePropose) resolvePropose();
                return;
            }

            // Method 2: Event query fallback
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
        }, 10000);

        return new Promise((resolve, reject) => {
            resolvePropose = resolve;
            const unwatch = watchContractEvent(
                CONTRACTS.hub,
                ABIS.hub,
                'HashProposed',
                { requestId: this.requestId },
                async (logs) => {
                    console.log('HashProposed event received - LP has sent XMR!');
                    for (const log of logs) {
                        if (log.args) {
                            await handleHashProposed(log.args);
                        }
                    }
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

    /**
     * Verify that the LP has sent XMR to the shared Monero address, then call
     * confirmMoneroLock on-chain. Creates a view-only Monero wallet to auto-scan
     * for incoming XMR. Falls back to manual confirmation if WASM wallet fails or
     * times out. On confirm, submits the on-chain transaction to commit the burn.
     */
    async confirmMoneroLock() {
        this.state = 'confirm-lock';
        updateSwapState({
            requestId: this.requestId,
            state: this.state,
            message: 'Verifying Monero transaction on blockchain...'
        });
        updateBurnProgress('confirm-lock', 'Scanning Monero blockchain for XMR...');
        showBurnVerificationLoading();

        // Relabel cancel button — LP has sent XMR, cancelling is destructive
        updateCancelBurnButton('↺ Cancel (available after deadline)', false);

        // Start deadline countdown interval — updates UI every 5s
        if (this.deadlineBlock) {
            this._confirmCountdown = setInterval(async () => {
                try {
                    const currentBlock = Number(await getPublicClient().getBlockNumber());
                    const blocksRemaining = this.deadlineBlock - currentBlock;
                    if (blocksRemaining > 0) {
                        const mins = Math.ceil(blocksRemaining * 5 / 60);
                        updateBurnProgress('confirm-lock', `Verifying XMR receipt... ${mins} min remaining to confirm`);
                    } else {
                        updateBurnProgress('confirm-lock', 'Verifying XMR receipt... deadline passed');
                    }
                } catch (e) {
                    // Ignore — burnFlow.js status messages will still show
                }
            }, 5000);
        }

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

        // Get restore height — use Monero height at LP propose time if available,
        // otherwise fall back to currentHeight - 50
        let restoreHeight = 0;
        if (this.moneroProposeHeight) {
            restoreHeight = Math.max(0, this.moneroProposeHeight - 2);
            console.log('Using stored Monero propose height as restore:', restoreHeight, '(propose was at', this.moneroProposeHeight + ')');
        } else {
            try {
                const moneroRpc = getMoneroRpc();
                const height = await moneroRpc.getHeight();
                restoreHeight = Math.max(0, height - 50);
                console.log('Monero blockchain height:', height, 'restore from:', restoreHeight);
            } catch (e) {
                console.warn('Could not reach Monero daemon for height:', e.message);
            }
        }

        return new Promise(async (resolve, reject) => {
            let confirmed = false;
            let viewWallet = null;
            let scanInterval = null;
            let timeoutId = null;

            const cleanup = () => {
                if (scanInterval) clearInterval(scanInterval);
                if (timeoutId) clearTimeout(timeoutId);
                if (this._confirmCountdown) { clearInterval(this._confirmCountdown); this._confirmCountdown = null; }
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

                // Pre-check: verify burn status is PROPOSED before submitting
                try {
                    const burnReq = await readHub('getBurnRequest', [this.requestId]);
                    const status = Number(burnReq.status);
                    if (status !== 2) {
                        const { showError } = await import('./ui.js?v=3.4');
                        if (status === 1) {
                            showError('Cannot Confirm Yet', 'The LP has not yet proposed a secret hash. Please wait for the LP to send XMR and commit on-chain.');
                        } else if (status === 3) {
                            showError('Already Confirmed', 'This burn has already been confirmed. Waiting for LP to finalize.');
                        } else if (status >= 4) {
                            showError('Burn Complete', 'This burn is already complete or cancelled.');
                        } else {
                            showError('Cannot Confirm', `Unexpected burn status: ${status}`);
                        }
                        return;
                    }
                } catch (checkErr) {
                    console.warn('[Burn] Could not pre-check burn status:', checkErr.message);
                }

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
                        message: 'Receipt confirmed on-chain. Waiting for LP to reveal secret...'
                    });

                    this.state = 'lp-finalize';
                    updateBurnProgress('lp-finalize', '✓ Receipt confirmed. Waiting for LP to reveal secret (step 4/5)...');
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
                txHash: '',
                confirmations: restoreHeight > 0 ? `Scanning from block ${restoreHeight.toLocaleString()}` : 'Preparing scan...',
                amount: this.wsxmrAmount
            });

            // Try auto-verification with monero-ts view-only wallet (user's own view key — trustless)
            try {
                showBurnScanProgress('Loading Monero WASM wallet for scanning...');

                let moneroTs;
                if (typeof window !== 'undefined' && window.monero_ts) {
                    moneroTs = window.monero_ts;
                } else {
                    throw new Error('Monero WASM module not loaded');
                }

                if (typeof moneroTs.createWalletFull !== 'function') {
                    throw new Error('Monero WASM bundle outdated — createWalletFull not available. Rebuild with: node build-monero-ts.mjs');
                }

                const mainnetType = (moneroTs.MoneroNetworkType && moneroTs.MoneroNetworkType.MAINNET !== undefined)
                    ? moneroTs.MoneroNetworkType.MAINNET
                    : 0;

                showBurnScanProgress('Creating view-only wallet to scan shared address...');
                console.log('[BurnVerify] Creating view-only wallet for address:', this.sharedMoneroAddress);

                // Use the connected daemon URL from moneroRpc for the WASM wallet too
                let wasmServerUri = MONERO_CONFIG.rpcUrl;
                let daemonHost = '';
                try {
                    const moneroRpc = getMoneroRpc();
                    wasmServerUri = await moneroRpc.getConnectedUrl();
                    daemonHost = new URL(wasmServerUri).hostname;
                } catch {}

                viewWallet = await moneroTs.createWalletFull({
                    password: 'burn-verify-tmp',
                    networkType: mainnetType,
                    primaryAddress: this.sharedMoneroAddress,
                    privateViewKey: viewKeyLe,
                    server: wasmServerUri,
                    restoreHeight: restoreHeight,
                    proxyToWorker: false,
                });

                showBurnScanProgress(`Syncing wallet via ${daemonHost}...`);
                await viewWallet.startSyncing();

                // Poll for incoming transactions — keep scanning until burn deadline
                let scanStartTime = Date.now();
                const scanTimeout = 30 * 60 * 1000; // 30 minutes (LP may need time to unlock XMR)

                const checkForXmr = async () => {
                    if (confirmed) return;
                    const elapsed = Date.now() - scanStartTime;
                    if (elapsed > scanTimeout) {
                        console.warn('[BurnVerify] Auto-scan timeout after 30min, falling back to manual confirm');
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
                            // Found incoming XMR — validate amount and confirmations
                            const unlockedBalance = await viewWallet.getUnlockedBalance();
                            const txs = await viewWallet.getTxs();
                            let confirmations = 0;
                            let receivedAmount = 0n;
                            let moneroTxHash = null;

                            for (const tx of txs) {
                                if (tx.getIncomingAmount && tx.getIncomingAmount) {
                                    const amt = BigInt(tx.getIncomingAmount().toString());
                                    if (amt > 0n) receivedAmount += amt;
                                }
                                if (tx.getNumConfirmations && tx.getNumConfirmations()) {
                                    confirmations = Math.max(confirmations, tx.getNumConfirmations());
                                }
                                if (tx.getHash && !moneroTxHash) {
                                    moneroTxHash = tx.getHash();
                                }
                            }

                            const xmrAmount = Number(receivedAmount) / 1e12;
                            const minConfirmations = MONERO_CONFIG.confirmations || 10;
                            const amountSufficient = receivedAmount >= expectedAtomic;
                            const confirmationsSufficient = confirmations >= minConfirmations;

                            console.log(`[BurnVerify] XMR found! Amount: ${receivedAmount} (expected ${expectedAtomic}), confirmations: ${confirmations} (need ${minConfirmations}), tx: ${moneroTxHash}`);

                            // Store the Monero tx hash for the "Verify on explorer" button
                            if (moneroTxHash) this.moneroTxHash = moneroTxHash;

                            if (!amountSufficient || !confirmationsSufficient) {
                                const reasons = [];
                                if (!amountSufficient) reasons.push(`insufficient amount (${xmrAmount}/${this.wsxmrAmount} XMR)`);
                                if (!confirmationsSufficient) reasons.push(`awaiting confirmations (${confirmations}/${minConfirmations})`);
                                console.warn(`[BurnVerify] Not ready to confirm: ${reasons.join(', ')}`);
                                showBurnScanProgress(`XMR received (${xmrAmount} XMR, ${confirmations} confs) — waiting for ${reasons.join(' & ')}`);
                                updateBurnProgress('confirm-lock', `XMR received (${xmrAmount} XMR, ${confirmations} confs) — waiting for ${reasons.join(' & ')}`);
                                // Update verification details with tx hash
                                if (moneroTxHash) {
                                    showBurnVerificationDetails({
                                        destination: this.sharedMoneroAddress || '',
                                        txHash: moneroTxHash,
                                        confirmations: `${confirmations} / ${minConfirmations} confirmations`,
                                        amount: `${xmrAmount} XMR`
                                    });
                                }
                                // Keep scanning — don't confirm yet
                                return;
                            }

                            showBurnXmrFound(xmrAmount, confirmations, moneroTxHash);
                            updateBurnProgress('confirm-lock', `✓ XMR verified: ${xmrAmount} XMR (${confirmations} confs)`);
                            // Update verification details with actual tx hash
                            showBurnVerificationDetails({
                                destination: this.sharedMoneroAddress || '',
                                txHash: moneroTxHash || '',
                                confirmations: `${confirmations} confirmations`,
                                amount: `${xmrAmount} XMR`
                            });
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

                        // No confirmed balance — check for mempool (0-conf) transactions
                        let mempoolAmount = 0n;
                        let mempoolTxHash = null;
                        try {
                            const txs = await viewWallet.getTxs();
                            for (const tx of txs) {
                                const isPending = (tx.isPending && tx.isPending()) || (tx.inTxPool && tx.inTxPool());
                                if (isPending && tx.getIncomingAmount) {
                                    const amt = BigInt(tx.getIncomingAmount().toString());
                                    if (amt > 0n) {
                                        mempoolAmount += amt;
                                        if (!mempoolTxHash && tx.getHash) mempoolTxHash = tx.getHash();
                                    }
                                }
                            }
                        } catch (poolErr) {
                            // getTxs may fail mid-sync — ignore, fall through to scan status
                        }

                        if (mempoolAmount > 0n) {
                            const pendingXmr = Number(mempoolAmount) / 1e12;
                            const minConfirmations = MONERO_CONFIG.confirmations || 10;
                            console.log(`[BurnVerify] XMR detected in mempool: ${pendingXmr} XMR, tx: ${mempoolTxHash}`);
                            if (mempoolTxHash) this.moneroTxHash = mempoolTxHash;
                            showBurnScanProgress(`✓ XMR detected in mempool (${pendingXmr} XMR) — awaiting confirmations (0/${minConfirmations})`);
                            updateBurnProgress('confirm-lock', `XMR detected (${pendingXmr} XMR, 0 confs) — awaiting confirmations`);
                            if (mempoolTxHash) {
                                showBurnVerificationDetails({
                                    destination: this.sharedMoneroAddress || '',
                                    txHash: mempoolTxHash,
                                    confirmations: `0 / ${minConfirmations} (in mempool)`,
                                    amount: `${pendingXmr} XMR`
                                });
                            }
                            // Show manual confirm button since we have evidence the LP sent
                            showBurnVerificationManual();
                            return;
                        }

                        // Still syncing or no XMR yet — show manual confirm alongside scan
                        const elapsedMin = Math.floor(elapsed / 60000);
                        const elapsedSec = Math.floor((elapsed % 60000) / 1000);
                        const blocksRemaining = daemonHeight - syncHeight;
                        const hostInfo = daemonHost ? ` via ${daemonHost}` : '';
                        if (blocksRemaining > 0) {
                            showBurnScanProgress(`Scanning${hostInfo}... ${syncHeight}/${daemonHeight} (${blocksRemaining} blocks left, ${elapsedMin}m${elapsedSec}s)`);
                        } else {
                            showBurnScanProgress(`Scanning${hostInfo}... synced at ${syncHeight}, no XMR yet (${elapsedMin}m${elapsedSec}s)`);
                        }
                        updateBurnProgress('confirm-lock', `Scanning Monero... ${syncHeight}/${daemonHeight}`);
                        // Show manual confirm button after 30s so user can confirm manually if they verified externally
                        if (elapsed > 30000) {
                            showBurnVerificationManual();
                        }
                    } catch (e) {
                        console.warn('[BurnVerify] Scan check error:', e.message);
                        showBurnScanProgress(`Scanning... (retrying)`);
                    }
                };

                // Check every 3 seconds for faster detection
                scanInterval = setInterval(checkForXmr, 3000);

                // Initial check after 2 seconds (let sync start)
                setTimeout(checkForXmr, 2000);

                // Overall timeout — same as scan timeout, no extra 10s
                timeoutId = setTimeout(() => {
                    if (!confirmed) {
                        console.warn('[BurnVerify] Overall timeout, falling back to manual');
                        clearInterval(scanInterval);
                        closeWallet().then(() => {
                            showBurnVerificationManual();
                            updateBurnProgress('confirm-lock', 'Auto-scan timeout — confirm manually');
                        });
                    }
                }, scanTimeout);

            } catch (wasmError) {
                console.warn('[BurnVerify] View-only wallet failed:', wasmError.message);
                await closeWallet();
                showBurnScanProgress('Auto-scan unavailable: ' + wasmError.message);
                showBurnVerificationManual();
                updateBurnProgress('confirm-lock', 'Auto-scan unavailable — verify XMR manually and confirm');
            }

            // Show manual confirm button immediately alongside auto-scan
            showBurnVerificationManual();

            // Wire up confirm button and manual verify button
            const wireButtons = () => {
                const btn = document.getElementById('burn-confirm-receipt');
                const manualBtn = document.getElementById('burn-confirm-receipt-manual');
                if (btn) btn.addEventListener('click', onConfirm);
                if (manualBtn) manualBtn.addEventListener('click', () => {
                    if (this.moneroTxHash) {
                        window.open(`https://xmrchain.net/tx/${this.moneroTxHash}`, '_blank');
                    } else if (this.sharedMoneroAddress) {
                        window.open(`https://xmrchain.net/search?value=${this.sharedMoneroAddress}`, '_blank');
                    } else {
                        window.open('https://xmrchain.net/', '_blank');
                    }
                });
            };
            wireButtons();
        });
    }

    /**
     * Wait for the LP to call finalizeBurn on-chain (reveals their Ed25519 secret).
     * Checks for past BurnFinalized events (resume support), then watches for new
     * events with polling fallback. On timeout, checks burn status and offers
     * claimSlashedCollateral if the LP failed to finalize.
     * @returns {Promise<string>} The LP's revealed secret (bytes32 hex)
     */
    async waitForLPFinalize() {
        this.state = 'lp-finalize';
        updateSwapState({ state: this.state });
        updateBurnProgress('lp-finalize', 'Waiting for LP to reveal secret (step 4/5)...');
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
            updateBurnProgress('lp-finalize', '✓ LP finalized — secret revealed');
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
                    updateBurnProgress('lp-finalize', '✓ LP finalized — secret revealed');
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
                                    await writeHub('resolveDeclinedProposal', [this.requestId, this.perBurnKeySet.secret]);
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

    /**
     * Sweep XMR from the shared Monero address to the user's destination.
     * Combines the user's Ed25519 secret with the LP's revealed secret to derive
     * the full private spend key, then uses monero-ts WASM wallet to sweep all funds.
     * Falls back to showing combined keys for manual import if sweep fails.
     * @param {string} lpSecret - The LP's revealed Ed25519 secret (bytes32 hex)
     */
    async sweepXMR(lpSecret) {
        this.state = 'sweeping';
        this._lastLpSecret = lpSecret; // Store for retry
        updateSwapState({ state: this.state, message: 'Claiming XMR from shared address...' });
        showBurnSweepProgress('Preparing to claim XMR...');

        const userSecret = this.perBurnKeySet.secret;
        const userViewKey = '0x' + this.perBurnKeySet.privateViewKey.toString(16).padStart(64, '0');

        // Get restore height from when the burn was proposed
        let restoreHeight = 0;
        try {
            if (this.moneroProposeHeight) {
                restoreHeight = this.moneroProposeHeight;
                console.log('[BurnSweep] Using propose-time restore height:', restoreHeight);
            } else {
                const moneroRpc = getMoneroRpc();
                restoreHeight = await moneroRpc.getHeight() - 50;
                console.log('[BurnSweep] Using current-50 restore height:', restoreHeight);
            }
        } catch (e) {
            console.warn('Could not get Monero height for restore:', e.message);
        }

        // Show "Copy keys for manual import" option alongside auto-sweep
        const keys = getCombinedKeysForImport(userSecret, lpSecret, userViewKey);
        showBurnKeysOption(keys, this.destination, restoreHeight);

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
                hideBurnKeysOption();
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
            showBurnKeysFallback(keys, this.destination, restoreHeight);

            // Save state so user can retry later — but don't throw, burn is already complete
            this._sweepFailed = true;
            updateSwapState({
                state: 'sweep-failed',
                lpSecret: lpSecret,
                message: 'Sweep failed. Use copied keys to claim XMR manually, or retry.'
            });
        }
    }

    /**
     * Mark the burn as completed — saves to history, clears active swap, cleans up event watchers.
     */
    async complete() {
        this.state = 'completed';
        
        const swapData = {
            type: 'burn',
            requestId: this.requestId,
            lpVault: this.lpVault,
            wsxmrAmount: this.wsxmrAmount,
            destination: this.destination,
            state: 'completed',
            sweepStatus: this._sweepFailed ? 'keys-provided' : 'swept',
            timestamp: Date.now()
        };
        
        saveToHistory(swapData);
        clearActiveSwap();
        this.cleanup();

        // Refresh vault data so mint capacity reflects the burned debt
        try {
            const { loadVaults } = await import('./main.js?v=' + Date.now());
            if (typeof loadVaults === 'function') {
                console.log('[Burn] Refreshing vault data after burn completion...');
                loadVaults();
            }
        } catch (e) {
            console.warn('[Burn] Could not refresh vault data:', e.message);
        }

        console.log('Burn flow completed! Sweep status:', swapData.sweepStatus);
    }

    /**
     * Claim slashed collateral on-chain (claimSlashedCollateral). Used when the LP
     * failed to finalize a COMMITTED burn after the grace period.
     */
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

    /**
     * Cancel or recover a burn based on its current on-chain status:
     * REQUESTED → abortBurn, PROPOSED → resolveDeclinedProposal,
     * COMMITTED → claimSlashedCollateral, SLASHED/CANCELLED → withdrawReturns.
     */
    async cancel() {
        console.log('Canceling burn...');

        if (this.requestId) {
            try {
                const burnReq = await readHub('getBurnRequest', [this.requestId]);
                const status = Number(burnReq.status);
                // BurnStatus: 0=INVALID, 1=REQUESTED, 2=PROPOSED, 3=COMMITTED, 4=COMPLETED, 5=SLASHED, 6=CANCELLED
                const deadlineBlock = Number(burnReq.deadline);
                const { showError } = await import('./ui.js?v=3.4');

                // Pre-check: is the deadline still in the future?
                let deadlinePassed = true;
                if (deadlineBlock > 0) {
                    try {
                        const currentBlock = Number(await (await import('./viemClient.js')).getPublicClient().getBlockNumber());
                        const blocksRemaining = deadlineBlock - currentBlock;
                        if (blocksRemaining > 0) {
                            deadlinePassed = false;
                            const minsRemaining = Math.ceil(blocksRemaining * 5 / 60);
                            if (status === 1) {
                                showError('Cannot Cancel Yet', `The burn deadline has not been reached. Approximately ${minsRemaining} minute(s) remaining until you can abort. The LP may still respond before then.`);
                            } else if (status === 2) {
                                showError('Cannot Cancel Yet', `The burn deadline has not been reached. Approximately ${minsRemaining} minute(s) remaining. The LP has already proposed and sent XMR — you should verify the XMR and confirm receipt instead of cancelling.`);
                            } else if (status === 3) {
                                showError('Cannot Claim Yet', `The burn deadline plus grace period has not been reached. Approximately ${minsRemaining} minute(s) remaining.`);
                            }
                            return;
                        }
                    } catch (e) {
                        console.warn('[Cancel] Could not fetch current block for deadline pre-check:', e.message);
                    }
                }

                const isDeadlineError = (err) => {
                    const msg = err.message || '';
                    return msg.includes('DeadlineNotExpired') || msg.includes('0xf525e320');
                };

                if (status === 1) {
                    // REQUESTED — user can abort after deadline
                    try {
                        await writeHub('abortBurn', [this.requestId]);
                        console.log('Burn aborted on EVM');
                    } catch (err) {
                        if (isDeadlineError(err)) {
                            showError('Cannot Cancel Yet', 'The burn deadline has not been reached yet. Please wait until the timeout expires.');
                            return;
                        }
                        throw err;
                    }
                } else if (status === 2) {
                    // PROPOSED — anyone can resolve after deadline
                    try {
                        await writeHub('resolveDeclinedProposal', [this.requestId, this.perBurnKeySet.secret]);
                        console.log('Burn proposal resolved (declined) on EVM');
                    } catch (err) {
                        if (isDeadlineError(err)) {
                            showError('Cannot Cancel Yet', 'The burn deadline has not been reached yet. The LP has already proposed and sent XMR — verify the XMR and confirm receipt instead.');
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
                        if (isDeadlineError(err)) {
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

    /**
     * Resume the burn flow from a saved state (after page refresh or crash).
     * Restores PhantomAgent from seed, re-derives shared address, and jumps to
     * the appropriate step based on the saved state.
     * @param {Object} savedState - Swap state from localStorage
     */
    async resume(savedState) {
        console.log('Resuming burn flow from state:', savedState.state);

        this.lpVault = savedState.lpVault;
        this.wsxmrAmount = savedState.wsxmrAmount;
        this.destination = savedState.destination;
        this.requestId = savedState.requestId;
        this.state = savedState.state;

        this.agent = getPhantomAgent();

        // Try to restore from saved seed first (like mintFlow does)
        let savedPublicSpendKey = savedState.publicSpendKey;
        if (!savedPublicSpendKey) {
            // publicSpendKey missing from saved state — try to recover it
            // 1. Read userPublicKey from on-chain burn request
            try {
                const burnReq = await readHub('getBurnRequest', [this.requestId]);
                const onChainKey = burnReq.userPublicKey;
                if (onChainKey && onChainKey !== '0x0000000000000000000000000000000000000000000000000000000000000000') {
                    savedPublicSpendKey = onChainKey;
                    console.log('[Burn Resume] Recovered publicSpendKey from on-chain burn request:', savedPublicSpendKey);
                }
            } catch (e) {
                console.warn('[Burn Resume] Could not read userPublicKey from chain:', e.message);
            }
            // 2. If still missing, scan localStorage for any stored seed
            if (!savedPublicSpendKey) {
                const { findStoredSeedKey } = await import('./seedStorage.js');
                const foundKey = findStoredSeedKey();
                if (foundKey) {
                    savedPublicSpendKey = foundKey;
                    console.log('[Burn Resume] Found stored seed key in localStorage:', savedPublicSpendKey);
                }
            }
        }

        if (savedPublicSpendKey) {
            const restored = await this.agent.loadExistingSeed(savedPublicSpendKey);
            if (!restored) {
                throw new Error(
                    'Could not restore swap secret from browser storage. ' +
                    'Clear browser data and start a new burn.'
                );
            }
            console.log('Agent restored from saved seed');
        } else {
            await this.agent.initialize('BURN', this.wsxmrAmount.toString(), this.destination);
        }

        // Re-derive per-burn key set from saved seed + burnNonce
        if (savedState.burnNonce != null) {
            this.burnNonce = savedState.burnNonce;
        } else if (this.requestId) {
            this.burnNonce = _getBurnNonceForRequest(this.requestId);
        }
        if (this.burnNonce != null && this.agent.seed) {
            this.perBurnKeySet = derivePerBurnKeySet(this.agent.seed, this.burnNonce);
            console.log('[Burn Resume] Re-derived per-burn key set (nonce=' + this.burnNonce + ')');
        } else {
            throw new Error('Cannot resume: per-burn key set could not be re-derived (missing seed or burnNonce)');
        }

        // Restore shared address and view key if available from saved state
        if (savedState.moneroAddress) this.sharedMoneroAddress = savedState.moneroAddress;
        if (savedState.viewKey) this.privateViewKeyHex = savedState.viewKey;
        if (savedState.moneroProposeHeight) this.moneroProposeHeight = savedState.moneroProposeHeight;

        switch (this.state) {
            case 'evm-request':
            case 'lp-propose':
                await this.waitForLPProposal();
                await this.confirmMoneroLock();
                const lpSecret1 = await this.waitForLPFinalize();
                { const { showBurnComplete } = await import('./ui.js?v=' + Date.now()); showBurnComplete(this.wsxmrAmount); }
                await this.sweepXMR(lpSecret1);
                await this.complete();
                break;
            case 'confirm-lock':
                await this.confirmMoneroLock();
                const lpSecret2 = await this.waitForLPFinalize();
                { const { showBurnComplete } = await import('./ui.js?v=' + Date.now()); showBurnComplete(this.wsxmrAmount); }
                await this.sweepXMR(lpSecret2);
                await this.complete();
                break;
            case 'lp-finalize':
                const lpSecret3 = await this.waitForLPFinalize();
                { const { showBurnComplete } = await import('./ui.js?v=' + Date.now()); showBurnComplete(this.wsxmrAmount); }
                await this.sweepXMR(lpSecret3);
                await this.complete();
                break;
            case 'sweeping':
            case 'sweep-failed':
                // Burn is already finalized on-chain — show completion banner immediately
                { const { showBurnComplete } = await import('./ui.js?v=' + Date.now()); showBurnComplete(this.wsxmrAmount); }
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

// ─── Per-burn nonce management (localStorage) ─────────────────────────────────

function _getNextBurnNonce() {
    const key = 'wrapsynth_burn_nonce';
    let nonce = 0;
    try {
        const stored = localStorage.getItem(key);
        if (stored) nonce = parseInt(stored, 10);
    } catch (e) { /* ignore */ }
    nonce++;
    try {
        localStorage.setItem(key, String(nonce));
    } catch (e) { /* ignore */ }
    return nonce;
}

function _storeBurnNonceMapping(requestId, burnNonce) {
    const key = 'wrapsynth_burn_nonce_map';
    try {
        const map = JSON.parse(localStorage.getItem(key) || '{}');
        map[requestId] = burnNonce;
        localStorage.setItem(key, JSON.stringify(map));
    } catch (e) { /* ignore */ }
}

function _getBurnNonceForRequest(requestId) {
    const key = 'wrapsynth_burn_nonce_map';
    try {
        const map = JSON.parse(localStorage.getItem(key) || '{}');
        return map[requestId] != null ? map[requestId] : null;
    } catch (e) { return null; }
}
