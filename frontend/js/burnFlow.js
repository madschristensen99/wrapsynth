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

import { CONTRACTS, ABIS, DECIMALS, SWAP_CONFIG, MONERO_CONFIG, ASSET, getActiveChain } from './config.js?v=3.31';
import { readHub, writeHub, writeHubUnsafe, readWsxmr, writeWsxmr, writeWsxmrUnsafe, watchContractEvent, getUserAddress, getPublicClient, getNativeBalance } from './viemClient.js?v=3.31';
import { getPhantomAgent } from './phantomAgent.js?v=3.31';
import { derivePerBurnKeySet } from './seedManager.js?v=3.31';
import { saveActiveSwap, updateSwapState, clearActiveSwap, saveToHistory } from './storage.js?v=3.31';
import { updateBurnProgress, showBurnVerificationLoading, showBurnVerificationDetails, showBurnVerificationManual, showBurnAddressPanel, showBurnKeysFallback, showBurnScanProgress, showBurnXmrFound, updateCancelBurnButton } from './ui.js?v=3.31';
import { getMoneroRpc } from './moneroRpc.js?v=3.31';
import { getCombinedKeysForImport, toLeHex } from './burnSweep.js?v=3.31';
import { keccak256, toHex, formatUnits } from 'https://esm.sh/viem@2.7.0';

export class BurnFlow {
    constructor() {
        this.state = 'idle';
        this.requestId = null;
        this.agent = null;
        this.lpVault = null;
        this.wsxmrAmount = null;
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
     */
    async start(lpVault, wsxmrAmount) {
        console.log('Starting burn flow:', { lpVault, wsxmrAmount });

        this.lpVault = lpVault;
        this.wsxmrAmount = wsxmrAmount;

        await this.initializeAgent();
        await this.requestBurnOnEVM();
        await this.waitForLPProposal();
        await this.confirmMoneroLock();
        const lpSecret = await this.waitForLPFinalize();
        
        // Burn is functionally complete — fire animation and banner now
        const { showBurnComplete } = await import('./ui.js?v=3.31');
        showBurnComplete(this.wsxmrAmount);
        
        // Sweep is a post-burn claim step — don't let failures block completion.
        // sweepXMR calls complete() itself only on a successful sweep, so a
        // failed sweep leaves the swap active and resumable.
        await this.sweepXMR(lpSecret);
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
            wsxmrAmount: this.wsxmrAmount
        });

        updateBurnProgress('init', 'Generating Ed25519 keys and deriving Monero address...');
        console.log('Initializing Phantom Agent...');
        
        this.agent = getPhantomAgent();
        const agentData = await this.agent.initialize('BURN', this.wsxmrAmount.toString());

        console.log('Agent initialized:', agentData);
        console.log('Derived Monero address for receiving XMR:', agentData.moneroAddress);

        // Store seed for resume (encrypted in browser) — same as mintFlow does
        const { storeSeed } = await import('./seedStorage.js?v=3.31');
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

        // Preflight funding check — wsXMR balance + gas. Surfaces a clear
        // message with acquire links instead of an opaque wallet revert.
        try {
            const [wsxmrBal, nativeBal] = await Promise.all([
                readWsxmr('balanceOf', [userAddress]).catch(() => null),
                getNativeBalance(userAddress).catch(() => null),
            ]);
            const chain = getActiveChain();
            const gasSym = chain?.nativeCurrency.symbol || 'ETH';
            const linkify = list => (list || [])
                .map(l => `<a href="${l.url.replace('{wsxmr}', CONTRACTS.wsxmrToken || '')}" target="_blank" rel="noopener" style="color:var(--accent,#f7931a)">${l.label} ↗</a>`)
                .join(' · ');
            if (wsxmrBal !== null && wsxmrBal < wsxmrAmountAtomic) {
                const { showError } = await import('./ui.js?v=3.31');
                const links = linkify(chain?.acquire?.wsxmr);
                showError('Not enough wsXMR',
                    `You have ${formatUnits(wsxmrBal, 8)} wsXMR but tried to burn ${formatUnits(wsxmrAmountAtomic, 8)}.` +
                    (links ? `<br><br>Get wsXMR: ${links}` : '<br><br>Get wsXMR by minting with XMR first.'));
                throw new Error('Insufficient wsXMR balance');
            }
            const gasBuffer = 500000000000000n; // ~0.0005 native
            if (nativeBal !== null && nativeBal < gasBuffer) {
                const { showError } = await import('./ui.js?v=3.31');
                const links = linkify(chain?.acquire?.gas);
                showError(`Not enough ${gasSym}`,
                    `Burning needs a small amount of ${gasSym} for gas; the wallet holds ${formatUnits(nativeBal, 18)} ${gasSym}.` +
                    (links ? `<br><br>Get ${gasSym}: ${links}` : ''));
                throw new Error(`Insufficient ${gasSym} for gas`);
            }
        } catch (err) {
            if (err.message?.includes('Insufficient')) throw err;
            console.warn('[Burn] Funding preflight failed — continuing:', err.message);
        }

        let receipt;
        const attemptRequestBurn = async () => {
            updateBurnProgress('evm-request', 'Step 3/3: Submitting burn request (check wallet)...');
            // Explicit padded gas — requestBurn's cost varies with vault state
            // (yield sync, pending-debt branch, request-array loops) and
            // wallet estimation can land below the real need → mined OOG,
            // funds burned but request unregistered. 1.5M ≈ 2.5x observed use
            // and still fits small-block chains (~2M/block on Orbit-style chains).
            return await writeHub('requestBurn', [
                wsxmrAmountAtomic,
                this.lpVault,
                userAddress,
                claimCommitment,
                userPublicKey,
                userViewKey
            ], 0n, 1500000n);
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
            // Persist the full per-burn key set — seed loss must not strand a burn
            _storeBurnKeySet(this.requestId, this.perBurnKeySet, this.burnNonce);
            // Record which master seed this burn derived from so resume targets
            // one seed instead of prompting a decrypt signature per stored seed
            try {
                const masterPub = this.agent?.keySet?.publicSpendKey;
                if (masterPub) {
                    localStorage.setItem('wrapsynth_burn_seedkey_' + this.requestId,
                        Array.from(masterPub).map(b => b.toString(16).padStart(2, '0')).join(''));
                }
            } catch (e) { /* ignore */ }
            
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
            this.lpProposeTimeout = blocksRemaining * (getActiveChain()?.blockTimeSec || 1) * 1000;
            console.log(`[Burn] On-chain deadline: block ${this.deadlineBlock}, current: ${currentBlock}, ${blocksRemaining} blocks remaining (~${Math.ceil(this.lpProposeTimeout / 60000)} min)`);
        } catch (err) {
            console.warn('[Burn] Could not fetch on-chain deadline, using fallback:', err.message);
        }

        // Helper to derive and show the burn address from LP public keys
        const deriveAndShowAddress = async (secretHash, lpPublicSpendKey, lpPublicViewKey) => {
            const { computeBurnAddress } = await import('./moneroCrypto.js?v=3.31');
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
            const { getPastEvents, getBlockNumber } = await import('./viemClient.js?v=3.31');
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
                const { getPastEvents, getBlockNumber } = await import('./viemClient.js?v=3.31');
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
                            const { showConfirmModal, showError, showSuccess } = await import('./ui.js?v=3.31');
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

        // Relabel + disable cancel button — cancelling is only possible after the deadline
        updateCancelBurnButton('↺ Cancel (available after deadline)', true);

        // Start deadline countdown interval — updates UI every 5s.
        // Re-fetch the deadline each tick: the contract resets it on proposeHash
        // (commit deadline) and again on commit, so a cached value goes stale.
        this._confirmCountdown = setInterval(async () => {
            try {
                const burnReq = await readHub('getBurnRequest', [this.requestId]);
                const deadlineBlock = Number(burnReq.deadline);
                const currentBlock = Number(await getPublicClient().getBlockNumber());
                const blocksRemaining = deadlineBlock - currentBlock;
                if (blocksRemaining > 0) {
                    const mins = Math.ceil(blocksRemaining * (getActiveChain()?.blockTimeSec || 1) / 60);
                    updateBurnProgress('confirm-lock', `Verifying XMR receipt... ${mins} min remaining to confirm`);
                } else {
                    updateBurnProgress('confirm-lock', 'Deadline passed — LP did not send XMR. Click Cancel to restore your wsXMR.');
                    updateCancelBurnButton('↺ Cancel Burn', false); // deadline reached — cancel is now valid
                }
            } catch (e) {
                // Ignore — burnFlow.js status messages will still show
            }
        }, 5000);

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
            // The LP's XMR tx can confirm BEFORE this height is recorded (it is
            // fetched after the tx is already in flight) — use a margin. The tx
            // confirms within ~10 blocks of propose, so 20 is safe and keeps the
            // first scan fast.
            restoreHeight = Math.max(0, this.moneroProposeHeight - 20);
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
            let daemonTxInterval = null;
            let abandonedInterval = null;

            const cleanup = () => {
                if (scanInterval) clearInterval(scanInterval);
                if (timeoutId) clearTimeout(timeoutId);
                if (daemonTxInterval) clearInterval(daemonTxInterval);
                if (abandonedInterval) clearInterval(abandonedInterval);
                if (this._confirmCountdown) { clearInterval(this._confirmCountdown); this._confirmCountdown = null; }
                const btn = document.getElementById('burn-confirm-receipt');
                const manualBtn = document.getElementById('burn-confirm-receipt-manual');
                if (btn) btn.replaceWith(btn.cloneNode(true));
                if (manualBtn) manualBtn.replaceWith(manualBtn.cloneNode(true));
                // Hide the manual confirm container — the user has confirmed (or the
                // burn was abandoned); there's nothing left to click.
                const manual = document.getElementById('burn-verification-manual');
                if (manual) manual.classList.add('hidden');
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
                        const { showError } = await import('./ui.js?v=3.31');
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
                            receipt = await writeHubUnsafe('confirmMoneroLock', [this.requestId], 0n, 1500000n);
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

            // Daemon-based auto-scan — scans recent Monero blocks for the LP's
            // XMR tx paying the shared address (decoded trustlessly with the
            // user's view key). Works for fresh burns too: the scan discovers
            // the txid, then the txid verifier tracks confirmations.
            let scanCursor = restoreHeight;
            const pollDaemonScan = async () => {
                if (confirmed) return;
                try {
                    const moneroRpc = getMoneroRpc();
                    const daemonUrl = await moneroRpc.getConnectedUrl();
                    const minConf = MONERO_CONFIG.confirmations || 10;

                    if (!this.moneroTxHash) {
                        // No txid yet — scan newly-mined blocks for the payment
                        const tip = await moneroRpc.getHeight();
                        if (tip <= scanCursor) return;
                        console.log(`[BurnVerify] Scanning blocks ${scanCursor} → ${tip - 1} for LP payment...`);
                        showBurnVerificationDetails({
                            destination: this.sharedMoneroAddress || '',
                            txHash: '',
                            confirmations: `Scanning blocks ${scanCursor.toLocaleString()} → ${(tip - 1).toLocaleString()}…`,
                            amount: `${this.wsxmrAmount} XMR`
                        });
                        const { scanBlocksForPayment } = await import('./moneroVerify.js?v=3.31');
                        const matches = await scanBlocksForPayment(daemonUrl, scanCursor, tip - 1, this.sharedMoneroAddress, viewKeyLe);
                        scanCursor = tip;
                        console.log(`[BurnVerify] Scan of ${scanCursor - restoreHeight} blocks found ${matches.length} match(es)`);
                        if (matches.length === 0) return;
                        const m = matches[0];
                        this.moneroTxHash = m.txid;
                        this.moneroTxHeight = m.height;
                        console.log(`[BurnVerify] Found LP payment tx ${m.txid} at height ${m.height}`);
                        updateSwapState({
                            requestId: this.requestId,
                            state: this.state,
                            moneroTxHash: this.moneroTxHash,
                            message: 'XMR payment found — verifying confirmations...'
                        });
                        showBurnVerificationDetails({
                            destination: this.sharedMoneroAddress || '',
                            txHash: this.moneroTxHash,
                            confirmations: 'Confirming…',
                            amount: `${this.wsxmrAmount} XMR`
                        });
                        return;
                    }

                    // Txid known — verify it pays the shared address + track confirmations
                    const { verifyTxPaysAddress } = await import('./moneroVerify.js?v=3.31');
                    const res = await verifyTxPaysAddress(daemonUrl, this.moneroTxHash, this.sharedMoneroAddress, viewKeyLe);

                    if (!res.found) {
                        // Tx exists but output doesn't pay us yet (or still relaying)
                        showBurnVerificationDetails({
                            destination: this.sharedMoneroAddress || '',
                            txHash: this.moneroTxHash,
                            confirmations: res.inPool ? `0 / ${minConf} (in mempool)` : 'Confirming…',
                            amount: `${this.wsxmrAmount} XMR`
                        });
                        return;
                    }

                    const confLabel = res.inPool
                        ? `0 / ${minConf} (in mempool)`
                        : `${res.confirmations} / ${minConf} confirmations`;
                    const xmrAmount = res.amount != null ? Number(res.amount) / 1e12 : this.wsxmrAmount;
                    showBurnVerificationDetails({
                        destination: this.sharedMoneroAddress || '',
                        txHash: this.moneroTxHash,
                        confirmations: confLabel,
                        amount: `${xmrAmount} XMR`
                    });

                    const amountSufficient = res.amount == null || res.amount >= expectedAtomic;
                    if (res.inPool) {
                        showBurnScanProgress(`✓ XMR verified to shared address — in mempool, awaiting confirmations (0/${minConf})`);
                        updateBurnProgress('confirm-lock', `XMR verified — in mempool, 0/${minConf} confirmations`);
                        showBurnVerificationManual();
                    } else if (res.confirmations < minConf || !amountSufficient) {
                        const why = !amountSufficient ? `amount ${xmrAmount} < expected` : `${res.confirmations}/${minConf} confirmations`;
                        showBurnScanProgress(`✓ XMR verified to shared address — ${why}`);
                        updateBurnProgress('confirm-lock', `XMR verified — ${why}`);
                        showBurnVerificationManual();
                    } else {
                        // Fully verified + enough confirmations — auto-confirm
                        console.log(`[BurnVerify] Daemon-verified ${xmrAmount} XMR to shared address, ${res.confirmations} confs — auto-confirming`);
                        showBurnXmrFound(xmrAmount, res.confirmations, this.moneroTxHash);
                        updateBurnProgress('confirm-lock', `✓ XMR verified: ${xmrAmount} XMR (${res.confirmations} confs)`);
                        updateSwapState({ requestId: this.requestId, state: this.state, message: `XMR verified: ${xmrAmount} XMR received` });
                        clearInterval(daemonTxInterval);
                        setTimeout(() => onConfirm(), 1500);
                    }
                } catch (e) {
                    console.warn('[BurnVerify] daemon scan error:', e);
                }
            };
            daemonTxInterval = setInterval(pollDaemonScan, 10000);
            setTimeout(pollDaemonScan, 1500); // first check almost immediately


            // Show manual confirm button immediately alongside auto-scan
            showBurnVerificationManual();

            // Wire up confirm button and manual verify button
            const wireButtons = () => {
                const btn = document.getElementById('burn-confirm-receipt');
                const manualBtn = document.getElementById('burn-confirm-receipt-manual');
                if (btn) btn.addEventListener('click', onConfirm);
                if (manualBtn) manualBtn.addEventListener('click', () => {
                    if (this.moneroTxHash) {
                        window.open(`https://moneroblocks.info/search/${this.moneroTxHash}`, '_blank');
                    } else if (this.sharedMoneroAddress) {
                        window.open(`https://moneroblocks.info/search/${this.sharedMoneroAddress}`, '_blank');
                    } else {
                        window.open('https://moneroblocks.info/', '_blank');
                    }
                });
            };
            wireButtons();

            // Watch for the LP abandoning the burn post-deadline (status 6 +
            // abandoned). When that happens, stop scanning and offer to restore
            // wsXMR directly instead of waiting for the user to hit Cancel.
            abandonedInterval = setInterval(async () => {
                if (confirmed) return;
                try {
                    const burnReq = await readHub('getBurnRequest', [this.requestId]);
                    if (Number(burnReq.status) === 6) {
                        const abandoned = await readHub('abandonedBurns', [this.requestId]);
                        if (abandoned) {
                            console.log('[Burn] Burn abandoned by LP — offering wsXMR restore');
                            confirmed = true;
                            cleanup();
                            await closeWallet();
                            const { showBurnRestorePanel, showSuccess, showError } = await import('./ui.js?v=3.31');
                            showBurnRestorePanel({
                                onRestore: async () => {
                                    try {
                                        const cancelled = await this.cancel();
                                        if (cancelled === false) return;
                                        const { resetBurnUI } = await import('./main.js?v=3.31' + Date.now());
                                        resetBurnUI();
                                        showSuccess('wsXMR Restored', 'Your wsXMR has been restored to your wallet.');
                                    } catch (err) {
                                        console.error('[Burn] Restore failed:', err);
                                        showError('Restore Failed', err.message || 'Failed to restore wsXMR');
                                        confirmed = false;
                                    }
                                }
                            });
                        }
                    }
                } catch (e) {
                    // Ignore transient RPC errors — keep polling
                }
            }, 15000);
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
        const { getPastEvents, getBlockNumber } = await import('./viemClient.js?v=3.31');
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
                    // Status check first — more reliable than event scans when the
                    // RPC is flaky. A COMPLETED burn exposes revealedSecret on-chain.
                    const burnReq = await readHub('getBurnRequest', [this.requestId]);
                    const revealed = burnReq.revealedSecret;
                    if (Number(burnReq.status) === 4 && revealed && revealed !== '0x' + '0'.repeat(64)) {
                        console.log('[Burn Poll] Burn COMPLETED on-chain — using revealedSecret from contract');
                        updateBurnProgress('lp-finalize', '✓ LP finalized — secret revealed');
                        const secret = handleFinalized(revealed);
                        if (secret !== null) {
                            unwatch();
                            resolve(secret);
                        }
                        return;
                    }
                } catch (e) {
                    console.warn('[Burn Poll] Status check error:', e.message);
                }
                try {
                    const { getPastEvents, getBlockNumber } = await import('./viemClient.js?v=3.31');
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

                        if (status === 4) {
                            // COMPLETED — the event was missed but the secret is on-chain
                            const revealed = burnReq.revealedSecret;
                            if (revealed && revealed !== '0x' + '0'.repeat(64)) {
                                updateBurnProgress('lp-finalize', '✓ LP finalized — secret revealed');
                                resolve(revealed);
                                return;
                            }
                        } else if (status === 3) {
                            const { showError, showConfirmModal } = await import('./ui.js?v=3.31');
                            const revealed = burnReq.revealedSecret && burnReq.revealedSecret !== '0x0000000000000000000000000000000000000000000000000000000000000000';
                            if (revealed) {
                                // LP revealed the secret but never settled — the burn is settleable
                                // by anyone. Slashing is blocked (the XMR claim is already public);
                                // settleBurn pays out the burn reward instead.
                                const confirmed = await showConfirmModal(
                                    'LP Revealed but Did Not Settle',
                                    '<p>The LP revealed the burn secret but did not settle on-chain. You can settle the burn yourself to claim your reward.</p><p>Would you like to settle now?</p>'
                                );
                                if (confirmed) {
                                    try {
                                        await writeHub('settleBurn', [this.requestId]);
                                        const { showSuccess } = await import('./ui.js?v=3.31');
                                        showSuccess('Burn Settled', 'Your reward has been queued. Withdraw it via Pending Returns.');
                                        resolve(burnReq.revealedSecret);
                                        return;
                                    } catch (settleErr) {
                                        showError('Settle Failed', settleErr.message || 'Failed to settle burn');
                                    }
                                }
                                reject(new Error('LP finalize timeout — burn can be settled'));
                                return;
                            }
                            // COMMITTED, not revealed — LP didn't finalize, user can claim slashed collateral
                            const confirmed = await showConfirmModal(
                                'LP Failed to Finalize',
                                '<p>The LP did not finalize the burn in time. You can claim slashed collateral (par value + reward) from the LP\'s vault.</p><p>Would you like to claim now?</p>'
                            );
                            if (confirmed) {
                                try {
                                    await this.claimSlashed();
                                    const { showSuccess } = await import('./ui.js?v=3.31');
                                    showSuccess('Slashed Collateral Claimed', `Your ${ASSET.collateral} has been queued. Withdraw it via Pending Returns.`);
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
                            const { showConfirmModal } = await import('./ui.js?v=3.31');
                            const confirmed = await showConfirmModal(
                                'LP Did Not Respond',
                                '<p>The LP did not respond to your burn request in time. You can abort the burn to recover your wsXMR.</p><p>Would you like to abort now?</p>'
                            );
                            if (confirmed) {
                                try {
                                    await writeHub('abortBurn', [this.requestId]);
                                    const { showSuccess } = await import('./ui.js?v=3.31');
                                    showSuccess('Burn Aborted', 'Your wsXMR has been restored.');
                                    resolve(null);
                                    return;
                                } catch (abortErr) {
                                    if (abortErr.message && abortErr.message.includes('DeadlineNotExpired')) {
                                        const { showError } = await import('./ui.js?v=3.31');
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
                            const { showConfirmModal } = await import('./ui.js?v=3.31');
                            const confirmed = await showConfirmModal(
                                'LP Proposal Expired',
                                '<p>The LP proposed a secret hash but did not lock XMR in time. You can resolve this to recover your wsXMR.</p><p>Would you like to resolve now?</p>'
                            );
                            if (confirmed) {
                                try {
                                    await writeHub('resolveDeclinedProposal', [this.requestId, this.perBurnKeySet.secret]);
                                    const { showSuccess } = await import('./ui.js?v=3.31');
                                    showSuccess('Burn Resolved', 'Your wsXMR has been restored.');
                                    resolve(null);
                                    return;
                                } catch (resolveErr) {
                                    if (resolveErr.message && resolveErr.message.includes('DeadlineNotExpired')) {
                                        const { showError } = await import('./ui.js?v=3.31');
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
     * Post-burn claim step. Combines the user's Ed25519 secret with the LP's
     * revealed secret to derive the full private spend key, then shows the keys
     * for manual import into a Monero wallet (GUI/Feather, "Restore from keys").
     * @param {string} lpSecret - The LP's revealed Ed25519 secret (bytes32 hex)
     */
    async sweepXMR(lpSecret) {
        this.state = 'sweeping';
        this._lastLpSecret = lpSecret; // Store for retry
        this._sweepFailed = true;      // Manual claim — keys are provided, not auto-swept
        updateSwapState({ state: this.state, message: 'Burn complete — claim your XMR with the keys below' });

        const userSecret = this.perBurnKeySet.secret;
        const userViewKey = '0x' + this.perBurnKeySet.privateViewKey.toString(16).padStart(64, '0');

        // Restore height from when the burn was proposed (minus margin so the
        // LP's tx is included when the wallet scans).
        let restoreHeight = 0;
        try {
            if (this.moneroProposeHeight) {
                restoreHeight = Math.max(0, this.moneroProposeHeight - 60);
                console.log('[BurnSweep] Using propose-time restore height:', restoreHeight);
            }
        } catch (e) {
            console.warn('Could not get Monero height for restore:', e.message);
        }

        // The browser WASM sweep is gone — the user imports these keys into a
        // Monero wallet (GUI/Feather, "Restore from keys") to claim the XMR.
        const keys = getCombinedKeysForImport(userSecret, lpSecret, userViewKey);
        showBurnKeysFallback(keys, restoreHeight, this.sharedMoneroAddress);

        updateSwapState({
            state: 'sweep-failed',
            lpSecret: lpSecret,
            sweepStatus: 'keys-provided',
            message: 'Burn complete — import the keys below to claim your XMR.'
        });
        await this.complete();
        return true;
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
            state: 'completed',
            sweepStatus: this._sweepFailed ? 'keys-provided' : 'swept',
            timestamp: Date.now()
        };
        
        saveToHistory(swapData);
        clearActiveSwap();
        this.cleanup();

        // Refresh vault data so mint capacity reflects the burned debt
        try {
            const { loadVaults } = await import('./main.js?v=3.31' + Date.now());
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
     * Requires revealing the per-burn user secret — the LP combines it with its own
     * secret to sweep the shared XMR (invariant: every exit reveals a secret).
     */
    async claimSlashed() {
        console.log('Claiming slashed collateral...');

        const userSecret = this.perBurnKeySet?.secret;
        if (!userSecret) {
            throw new Error('Cannot claim slashed collateral: per-burn secret unavailable. Restore your seed phrase to recover.');
        }

        try {
            const receipt = await writeHub('claimSlashedCollateral', [this.requestId, userSecret]);
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
                const { showError } = await import('./ui.js?v=3.31');

                // Pre-check: is the deadline still in the future?
                let deadlinePassed = true;
                if (deadlineBlock > 0) {
                    try {
                        const currentBlock = Number(await (await import('./viemClient.js?v=3.31')).getPublicClient().getBlockNumber());
                        const blocksRemaining = deadlineBlock - currentBlock;
                        if (blocksRemaining > 0) {
                            deadlinePassed = false;
                            const minsRemaining = Math.ceil(blocksRemaining * (getActiveChain()?.blockTimeSec || 1) / 60);
                            if (status === 1) {
                                showError('Cannot Cancel Yet', `The burn deadline has not been reached. Approximately ${minsRemaining} minute(s) remaining until you can abort. The LP may still respond before then.`);
                            } else if (status === 2) {
                                showError('Cannot Cancel Yet', `The burn deadline has not been reached. Approximately ${minsRemaining} minute(s) remaining. The LP has already proposed and sent XMR — you should verify the XMR and confirm receipt instead of cancelling.`);
                            } else if (status === 3) {
                                showError('Cannot Claim Yet', `The burn deadline plus grace period has not been reached. Approximately ${minsRemaining} minute(s) remaining.`);
                            }
                            return false;
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
                            return false;
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
                            return false;
                        }
                        throw err;
                    }
                } else if (status === 3) {
                    // COMMITTED — user can claim slashed collateral after deadline + grace.
                    // Requires revealing the per-burn secret so the LP can sweep the shared XMR.
                    if (!this.perBurnKeySet?.secret) {
                        showError('Cannot Claim', 'Your per-burn secret is unavailable. Restore your seed phrase to claim slashed collateral.');
                        return;
                    }
                    try {
                        await writeHub('claimSlashedCollateral', [this.requestId, this.perBurnKeySet.secret]);
                        console.log('Slashed collateral claimed on EVM');
                    } catch (err) {
                        if (isDeadlineError(err)) {
                            showError('Cannot Claim Yet', 'The burn deadline plus grace period has not been reached yet. Please wait a bit longer.');
                            return false;
                        }
                        throw err;
                    }
                } else if (status === 4) {
                    // COMPLETED — nothing to cancel
                    console.log('Burn already completed');
                } else if (status === 5) {
                    // SLASHED — claim any pending returns
                    await writeHub('withdrawReturns', ['0x0000000000000000000000000000000000000000']);
                    console.log('Pending returns withdrawn');
                } else if (status === 6) {
                    // CANCELLED — if the LP abandoned a PROPOSED burn, the wsXMR is still
                    // claimable via resolveDeclinedProposal (revealing userSecret also lets
                    // the LP sweep the shared XMR). Otherwise just withdraw any returns.
                    let abandoned = false;
                    try {
                        abandoned = await readHub('abandonedBurns', [this.requestId]);
                    } catch (e) {
                        console.warn('[Cancel] Could not read abandonedBurns:', e.message);
                    }
                    if (abandoned && this.perBurnKeySet && this.perBurnKeySet.secret) {
                        await writeHub('resolveDeclinedProposal', [this.requestId, this.perBurnKeySet.secret]);
                        console.log('Late claim: wsXMR restored via resolveDeclinedProposal (userSecret revealed for LP sweep)');
                    } else if (abandoned) {
                        const { showError } = await import('./ui.js?v=3.31');
                        showError('Claim Available', 'This burn was abandoned by the LP. Your wsXMR is still claimable, but your burn secret is unavailable — restore your seed phrase and retry.');
                        return false;
                    } else {
                        await writeHub('withdrawReturns', ['0x0000000000000000000000000000000000000000']);
                        console.log('Pending returns withdrawn');
                    }
                } else {
                    console.warn(`Burn status is ${status}; no cancel action possible`);
                }
            } catch (error) {
                console.error('Error canceling burn on EVM:', error);
                const { showError } = await import('./ui.js?v=3.31');
                showError('Cancel Failed', error.message || 'Failed to cancel burn');
                return false;
            }
        }

        clearActiveSwap();
        this.cleanup();
        return true;
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
        this.requestId = savedState.requestId;
        this.state = savedState.state;
        // Restore Monero tracking fields persisted during verify — needed so the
        // sweep's confirmation gate can poll the tx after a reload.
        this.moneroTxHash = savedState.moneroTxHash || null;
        this.sharedMoneroAddress = savedState.sharedMoneroAddress || null;
        this.moneroProposeHeight = savedState.moneroProposeHeight || savedState.restoreHeight || null;

        // Normalize wsxmrAmount to human units — older saved states stored raw 1e8
        // integers (e.g. "11500" instead of 0.000115), which broke the XMR amount check.
        try {
            const burnReq = await readHub('getBurnRequest', [this.requestId]);
            this.wsxmrAmount = Number(burnReq.wsxmrAmount) / 1e8;
        } catch {
            let amt = Number(savedState.wsxmrAmount);
            if (Number.isInteger(amt) && amt > 1000) amt /= 1e8;
            this.wsxmrAmount = amt;
        }

        this.agent = getPhantomAgent();

        // Read the on-chain userPublicKey once — used to verify/identify keys.
        let onChainPub = null;
        try {
            const burnReq = await readHub('getBurnRequest', [this.requestId]);
            const k = (burnReq.userPublicKey || '').toLowerCase();
            if (k && k !== '0x' + '0'.repeat(64)) onChainPub = k;
        } catch (e) {
            console.warn('[Burn Resume] Could not read burn request:', e.message);
        }

        const pubHex = (ks) => ks && ks.publicSpendKey
            ? '0x' + Array.from(ks.publicSpendKey).map(b => b.toString(16).padStart(2, '0')).join('')
            : null;

        // Fast path: a persisted per-burn key set needs no seed at all.
        const storedKeySet = this.requestId ? _getBurnKeySet(this.requestId) : null;
        if (storedKeySet && (!onChainPub || pubHex(storedKeySet) === onChainPub)) {
            this.perBurnKeySet = storedKeySet;
            this.burnNonce = storedKeySet.burnNonce;
            console.log('[Burn Resume] Restored per-burn key set from local storage');
        } else {
            if (storedKeySet) console.warn('[Burn Resume] Stored key set does not match on-chain key — ignoring');

            // Seed path: try EVERY stored seed — the burn's seed may not be the first.
            // Versioned import busts caches that still hold the old module.
            const seedStorage = await import('./seedStorage.js?v=3.31');
            const allKeys = typeof seedStorage.findAllStoredSeedKeys === 'function'
                ? seedStorage.findAllStoredSeedKeys()
                : [seedStorage.findStoredSeedKey && seedStorage.findStoredSeedKey()].filter(Boolean);
            const candidates = [];
            // The seed recorded at burn creation is almost certainly the right one —
            // try it first so resume needs a single decrypt signature, not N.
            const mappedSeedKey = this.requestId
                ? localStorage.getItem('wrapsynth_burn_seedkey_' + this.requestId)
                : null;
            if (mappedSeedKey) candidates.push(mappedSeedKey);
            if (savedState.publicSpendKey && !candidates.includes(savedState.publicSpendKey)) {
                candidates.push(savedState.publicSpendKey);
            }
            for (const k of allKeys) {
                if (!candidates.includes(k)) candidates.push(k);
            }

            // Known nonce first, then scan up to the nonce counter.
            const knownNonce = savedState.burnNonce != null
                ? savedState.burnNonce
                : (this.requestId ? _getBurnNonceForRequest(this.requestId) : null);
            let maxNonce = 500;
            try {
                const c = parseInt(localStorage.getItem('wrapsynth_burn_nonce'), 10);
                if (!isNaN(c)) maxNonce = Math.max(maxNonce, c);
            } catch (e) { /* ignore */ }

            let matched = null;
            for (const pubKey of candidates) {
                const restored = await this.agent.loadExistingSeed(pubKey);
                if (!restored || !this.agent.seed) continue;

                if (knownNonce != null) {
                    const ks = derivePerBurnKeySet(this.agent.seed, knownNonce);
                    if (!onChainPub || pubHex(ks) === onChainPub) {
                        matched = { keySet: ks, nonce: knownNonce };
                    }
                }
                if (!matched && onChainPub) {
                    for (let n = 0; n <= maxNonce && !matched; n++) {
                        if (n === knownNonce) continue;
                        const ks = derivePerBurnKeySet(this.agent.seed, n);
                        if (pubHex(ks) === onChainPub) matched = { keySet: ks, nonce: n };
                    }
                    // Legacy burns used the master key set directly
                    if (!matched && pubHex(this.agent.keySet) === onChainPub) {
                        matched = { keySet: this.agent.keySet, nonce: null };
                    }
                }
                if (matched) break;
            }

            if (matched) {
                this.perBurnKeySet = matched.keySet;
                this.burnNonce = matched.nonce;
                if (matched.nonce != null) _storeBurnNonceMapping(this.requestId, matched.nonce);
                _storeBurnKeySet(this.requestId, matched.keySet, matched.nonce);
                console.log('[Burn Resume] Key set recovered (nonce=' + matched.nonce + ')');
            } else if (!onChainPub && this.agent.seed && knownNonce != null) {
                // Can't verify against chain — best effort with the known nonce
                this.perBurnKeySet = derivePerBurnKeySet(this.agent.seed, knownNonce);
                this.burnNonce = knownNonce;
            } else {
                throw new Error('Cannot resume: no stored seed matches this burn (seed lost or created in another browser).');
            }
        }

        if (!this.perBurnKeySet) {
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
                { const { showBurnComplete } = await import('./ui.js?v=3.31'); showBurnComplete(this.wsxmrAmount); }
                await this.sweepXMR(lpSecret1);
                break;
            case 'confirm-lock':
                await this.confirmMoneroLock();
                const lpSecret2 = await this.waitForLPFinalize();
                { const { showBurnComplete } = await import('./ui.js?v=3.31'); showBurnComplete(this.wsxmrAmount); }
                await this.sweepXMR(lpSecret2);
                break;
            case 'lp-finalize':
                const lpSecret3 = await this.waitForLPFinalize();
                { const { showBurnComplete } = await import('./ui.js?v=3.31'); showBurnComplete(this.wsxmrAmount); }
                await this.sweepXMR(lpSecret3);
                break;
            case 'sweeping':
            case 'sweep-failed': {
                // Burn is already finalized on-chain — show completion banner immediately
                const { showBurnComplete } = await import('./ui.js?v=3.31');
                showBurnComplete(this.wsxmrAmount);
                // Prefer the revealed secret straight from contract state — reliable
                // even when event scans fail on flaky RPCs.
                let lpSecret = null;
                try {
                    const burnReq = await readHub('getBurnRequest', [this.requestId]);
                    const revealed = burnReq.revealedSecret;
                    if (revealed && revealed !== '0x' + '0'.repeat(64)) lpSecret = revealed;
                } catch (e) {
                    console.warn('[Burn Resume] getBurnRequest failed, falling back to event scan:', e.message);
                }
                if (!lpSecret) {
                    const { getPastEvents, getBlockNumber } = await import('./viemClient.js?v=3.31');
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
                    if (pastEvents && pastEvents.length > 0) lpSecret = pastEvents[0].args.secret;
                }
                if (lpSecret) {
                    await this.sweepXMR(lpSecret);
                } else {
                    throw new Error('Cannot resume: LP secret not found on-chain');
                }
                break;
            }
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

// ─── Per-burn key set persistence (localStorage) ─────────────────────────────
// The per-burn secret is the ONLY thing needed to claim the XMR or resolve a
// declined proposal — persist it per-requestId so seed loss can't strand a burn.

function _storeBurnKeySet(requestId, keySet, burnNonce) {
    try {
        const hex = (arr) => '0x' + Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
        localStorage.setItem('wrapsynth_burn_keyset_' + requestId, JSON.stringify({
            secret: keySet.secret,
            privateViewKey: '0x' + keySet.privateViewKey.toString(16).padStart(64, '0'),
            publicSpendKey: hex(keySet.publicSpendKey),
            publicViewKey: hex(keySet.publicViewKey),
            commitment: keySet.commitment,
            burnNonce
        }));
    } catch (e) { /* ignore */ }
}

function _getBurnKeySet(requestId) {
    try {
        const raw = localStorage.getItem('wrapsynth_burn_keyset_' + requestId);
        if (!raw) return null;
        const d = JSON.parse(raw);
        const bytes = (h) => Uint8Array.from(h.slice(2).match(/../g).map(x => parseInt(x, 16)));
        return {
            secret: d.secret,
            privateViewKey: BigInt(d.privateViewKey),
            publicSpendKey: bytes(d.publicSpendKey),
            publicViewKey: bytes(d.publicViewKey),
            commitment: d.commitment,
            burnNonce: d.burnNonce
        };
    } catch (e) { return null; }
}
