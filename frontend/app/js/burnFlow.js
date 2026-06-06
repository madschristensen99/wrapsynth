// Burn Flow - wsXMR to XMR (5-step Diamond Architecture)

import { CONTRACTS, ABIS, DECIMALS, SWAP_CONFIG } from './config.js';
import { readHub, writeHub, readWsxmr, writeWsxmr, watchContractEvent, getUserAddress } from './viemClient.js';
import { getPhantomAgent } from './phantomAgent.js';
import { getLPClient } from './lpClient.js';
import { saveActiveSwap, updateSwapState, clearActiveSwap, saveToHistory } from './storage.js';
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
        this.lpClient = getLPClient();
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

        updateSwapState({
            moneroAddress: agentData.moneroAddress
        });
    }

    async requestBurnOnEVM() {
        this.state = 'evm-request';
        updateSwapState({ state: this.state });

        console.log('Requesting burn on EVM...');

        const userAddress = getUserAddress();
        const wsxmrAmountAtomic = BigInt(Math.floor(this.wsxmrAmount * Math.pow(10, DECIMALS.wsXMR)));

        await writeWsxmr('approve', [CONTRACTS.hub, wsxmrAmountAtomic]);
        console.log('wsXMR approved for burn');

        const receipt = await writeHub('requestBurn', [
            wsxmrAmountAtomic,
            this.lpVault,
            userAddress
        ]);

        console.log('Burn requested, tx:', receipt.transactionHash);

        const burnRequestedEvent = receipt.logs.find(log => 
            log.topics[0] === keccak256(toHex('BurnRequested(bytes32,address,address,uint256,uint256,uint256)'))
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
        console.log('Waiting for LP to propose secret hash...');

        const pollStatus = async () => {
            try {
                const status = await this.lpClient.getBurnStatus(this.requestId);
                console.log('Burn status:', status);
                
                if (status.status === 'HASH_PROPOSED' || status.status === 'COMMITTED') {
                    this.secretHash = status.secret_hash;
                    return true;
                }
                
                updateSwapState({
                    requestId: this.requestId,
                    lpStatus: status.status,
                    lpMessage: status.message
                });
            } catch (error) {
                console.warn('LP status poll failed:', error);
            }
            return false;
        };

        return new Promise((resolve, reject) => {
            const unwatch = watchContractEvent(
                CONTRACTS.hub,
                ABIS.hub,
                'HashProposed',
                { requestId: this.requestId },
                (log) => {
                    console.log('HashProposed event received');
                    this.secretHash = log.args.secretHash;
                    clearInterval(pollInterval);
                    unwatch();
                    resolve();
                }
            );

            const pollInterval = setInterval(async () => {
                if (await pollStatus()) {
                    clearInterval(pollInterval);
                    unwatch();
                    resolve();
                }
            }, SWAP_CONFIG.pollInterval);

            this.eventWatchers.push(unwatch);

            setTimeout(() => {
                clearInterval(pollInterval);
                unwatch();
                reject(new Error('LP proposal timeout'));
            }, 1800000);
        });
    }

    async confirmMoneroLock() {
        this.state = 'confirm-lock';
        updateSwapState({ requestId: this.requestId, state: this.state });

        console.log('User confirming Monero lock...');
        console.log('Please verify XMR has been received at:', this.destination);

        const confirmed = confirm(
            `Have you received XMR at your Monero address?\n\n` +
            `Address: ${this.destination}\n` +
            `Expected amount: ~${this.wsxmrAmount} XMR\n\n` +
            `Click OK only after verifying the transaction in your Monero wallet.`
        );

        if (!confirmed) {
            throw new Error('User did not confirm Monero lock');
        }

        const receipt = await writeHub('confirmMoneroLock', [this.requestId]);
        
        console.log('Monero lock confirmed, tx:', receipt.transactionHash);

        updateSwapState({
            requestId: this.requestId,
            state: 'lp-finalize',
            confirmTxHash: receipt.transactionHash
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
