// Burn Flow - wsXMR to XMR (5-step Diamond Architecture)

import { CONTRACTS, ABIS, DECIMALS, SWAP_CONFIG } from './config.js';
import { readHub, writeHub, writeHubUnsafe, readWsxmr, writeWsxmr, watchContractEvent, getUserAddress } from './viemClient.js';
import { getPhantomAgent } from './phantomAgent.js';
import { saveActiveSwap, updateSwapState, clearActiveSwap, saveToHistory } from './storage.js';
import { updateBurnProgress, showBurnVerificationLoading, showBurnVerificationDetails, showBurnVerificationManual, showBurnAddressPanel } from './ui.js?v=2.3';
import { getMoneroRpc } from './moneroRpc.js';
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
        await this.waitForLPFinalize();
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

        updateSwapState({
            moneroAddress: agentData.moneroAddress,
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

        await writeWsxmr('approve', [CONTRACTS.hub, wsxmrAmountAtomic]);
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

        return new Promise((resolve, reject) => {
            const unwatch = watchContractEvent(
                CONTRACTS.hub,
                ABIS.hub,
                'HashProposed',
                { requestId: this.requestId },
                async (log) => {
                    console.log('HashProposed event received - LP has sent XMR!');
                    const event = log.args;
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
                    clearInterval(countdownInterval);
                    unwatch();
                    resolve();
                }
            );

            this.eventWatchers.push(unwatch);

            setTimeout(() => {
                clearInterval(countdownInterval);
                unwatch();
                reject(new Error('LP proposal timeout - LP did not send XMR in time'));
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
        updateBurnProgress('confirm-lock', 'Checking Monero blockchain...');
        showBurnVerificationLoading();

        console.log('LP has sent XMR to:', this.destination);
        console.log('Expected amount:', this.wsxmrAmount, 'XMR');
        console.log('Secret hash:', this.secretHash);

        const moneroRpc = getMoneroRpc();

        // Fetch Monero chain status directly from public daemon (no LP server)
        let moneroHeight = null;
        try {
            moneroHeight = await moneroRpc.getHeight();
            console.log('Monero blockchain height:', moneroHeight);
        } catch (e) {
            console.warn('Could not reach Monero daemon:', e);
        }

        return new Promise((resolve, reject) => {
            let scanInterval = null;
            let timeoutId = null;
            let confirmed = false;

            const cleanup = () => {
                if (scanInterval) clearInterval(scanInterval);
                if (timeoutId) clearTimeout(timeoutId);
                const btn = document.getElementById('burn-confirm-receipt');
                const manualBtn = document.getElementById('burn-confirm-receipt-manual');
                if (btn) btn.replaceWith(btn.cloneNode(true));
                if (manualBtn) manualBtn.replaceWith(manualBtn.cloneNode(true));
            };

            const onConfirm = async () => {
                if (confirmed) return;
                confirmed = true;
                cleanup();
                updateBurnProgress('confirm-lock', 'Submitting confirmation to blockchain...');

                try {
                    const receipt = await writeHub('confirmMoneroLock', [this.requestId]);
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
                    reject(error);
                }
            };

            // Wire up both confirm buttons
            const wireButtons = () => {
                const btn = document.getElementById('burn-confirm-receipt');
                const manualBtn = document.getElementById('burn-confirm-receipt-manual');
                if (btn) btn.addEventListener('click', onConfirm);
                if (manualBtn) manualBtn.addEventListener('click', onConfirm);
            };
            wireButtons();

            // Show verification details immediately with what we know from on-chain data
            showBurnVerificationDetails({
                destination: this.destination || '',
                txHash: this.secretHash ? `Secret hash: ${this.secretHash.slice(0, 16)}...${this.secretHash.slice(-16)}` : 'Unknown',
                confirmations: moneroHeight !== null ? `Daemon height ${moneroHeight.toLocaleString()}` : 'Daemon unreachable',
                amount: this.wsxmrAmount
            });

            // The LP sends XMR to the shared address but does not embed the secret hash
            // in the Monero tx extra. The user should verify via their own Monero wallet
            // or block explorer, then manually confirm receipt.
            console.log('Monero verification: user must manually confirm receipt of XMR');
            showBurnVerificationManual();
            updateBurnProgress('confirm-lock', 'Confirm receipt of XMR to proceed...');
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

        return new Promise((resolve, reject) => {
            const unwatch = watchContractEvent(
                CONTRACTS.hub,
                ABIS.hub,
                'BurnFinalized',
                { requestId: this.requestId },
                (log) => {
                    console.log('BurnFinalized event received');
                    const secret = log.args.secret;
                    console.log('Secret revealed:', secret);
                    unwatch();
                    resolve(secret);
                }
            );

            this.eventWatchers.push(unwatch);

            setTimeout(() => {
                unwatch();
                reject(new Error('LP finalize timeout'));
            }, 1800000);
        });
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
                await writeHub('cancelBurn', [this.requestId]);
                console.log('Burn request canceled on EVM');
            } catch (error) {
                console.error('Error canceling burn on EVM:', error);
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

        switch (this.state) {
            case 'lp-propose':
                await this.waitForLPProposal();
                await this.confirmMoneroLock();
                await this.waitForLPFinalize();
                await this.complete();
                break;
            case 'confirm-lock':
                await this.confirmMoneroLock();
                await this.waitForLPFinalize();
                await this.complete();
                break;
            case 'lp-finalize':
                await this.waitForLPFinalize();
                await this.complete();
                break;
            default:
                throw new Error('Cannot resume from state: ' + this.state);
        }
    }
}
