// Burn Flow - wsXMR to XMR (5-step Diamond Architecture)

import { CONTRACTS, ABIS, DECIMALS, SWAP_CONFIG } from './config.js';
import { readHub, writeHub, writeHubUnsafe, readWsxmr, writeWsxmr, watchContractEvent, getUserAddress } from './viemClient.js';
import { getPhantomAgent } from './phantomAgent.js';
import { saveActiveSwap, updateSwapState, clearActiveSwap, saveToHistory } from './storage.js';
import { updateBurnProgress } from './ui.js';
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

        // Get the user's Ed25519 commitment (same as mint flow)
        const claimCommitment = this.agent.getCommitment();
        console.log('Using claim commitment for burn:', claimCommitment);

        let receipt;
        const attemptRequestBurn = async () => {
            return await writeHub('requestBurn', [
                wsxmrAmountAtomic,
                this.lpVault,
                userAddress,
                claimCommitment
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
                    claimCommitment
                ], 0n, 3000000n);
            } else {
                throw error;
            }
        }

        console.log('Burn requested, tx:', receipt.transactionHash);

        const burnRequestedEvent = receipt.logs.find(log => 
            log.topics[0] === keccak256(toHex('BurnRequested(bytes32,address,address,uint256,uint256,uint256,bytes32)'))
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

        // Update countdown in swap state while waiting
        const countdownInterval = setInterval(() => {
            const elapsed = Date.now() - this.lpProposeStartTime;
            const remaining = Math.max(0, this.lpProposeTimeout - elapsed);
            updateSwapState({
                requestId: this.requestId,
                lpStatus: 'waiting',
                lpMessage: 'LP is sending XMR to your Monero address...',
                lpProposeRemaining: remaining
            });
        }, SWAP_CONFIG.pollInterval);

        return new Promise((resolve, reject) => {
            const unwatch = watchContractEvent(
                CONTRACTS.hub,
                ABIS.hub,
                'HashProposed',
                { requestId: this.requestId },
                (log) => {
                    console.log('HashProposed event received - LP has sent XMR!');
                    this.secretHash = log.args.secretHash;
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
            message: 'Waiting for you to verify XMR arrival in your Monero wallet...'
        });

        console.log('\n=== MONERO VERIFICATION REQUIRED ===');
        console.log('LP has sent XMR to your Monero address!');
        console.log('\nYour receiving address:', this.destination);
        console.log('Expected amount:', this.wsxmrAmount, 'XMR');
        console.log('\nIMPORTANT: Check your Monero wallet to verify the funds arrived.');
        console.log('You can use:');
        console.log('  - Monero GUI wallet');
        console.log('  - Monero CLI wallet');
        console.log('  - MyMonero web wallet');
        console.log('  - Or any other Monero wallet that supports your address');
        console.log('\nOnce verified, click OK in the confirmation dialog.');
        console.log('====================================\n');

        // Show user-friendly dialog with better instructions
        const confirmed = confirm(
            `🔍 VERIFY MONERO TRANSACTION\n\n` +
            `The LP has sent XMR to your Monero wallet!\n\n` +
            `📍 Your address:\n${this.destination}\n\n` +
            `💰 Expected amount: ${this.wsxmrAmount} XMR\n\n` +
            `⚠️ IMPORTANT: Open your Monero wallet and verify that:\n` +
            `   1. The transaction appears in your wallet\n` +
            `   2. The amount matches (${this.wsxmrAmount} XMR)\n` +
            `   3. The transaction has at least 1 confirmation\n\n` +
            `✅ Click OK ONLY after verifying in your Monero wallet\n` +
            `❌ Click Cancel if you haven't received the XMR yet`
        );

        if (!confirmed) {
            updateSwapState({
                requestId: this.requestId,
                message: 'Waiting for you to verify... Check your Monero wallet and try again.'
            });
            throw new Error('User has not verified Monero receipt yet. Please check your wallet and try again.');
        }

        console.log('User confirmed XMR receipt, submitting on-chain confirmation...');
        updateSwapState({
            requestId: this.requestId,
            message: 'Submitting confirmation to blockchain...'
        });

        const receipt = await writeHub('confirmMoneroLock', [this.requestId]);
        
        console.log('✅ Monero lock confirmed on-chain, tx:', receipt.transactionHash);

        updateSwapState({
            requestId: this.requestId,
            state: 'lp-finalize',
            confirmTxHash: receipt.transactionHash,
            message: 'Confirmed! Waiting for LP to finalize...'
        });

        this.state = 'lp-finalize';
    }

    async waitForLPFinalize() {
        console.log('Waiting for LP to finalize burn...');

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
