// Mint Flow - XMR to wsXMR (Diamond Architecture + LP Server Integration)

import { CONTRACTS, ABIS, DECIMALS, SWAP_CONFIG } from './config.js';
import { readHub, writeHub, watchContractEvent, getUserAddress } from './viemClient.js';
import { getPhantomAgent } from './phantomAgent.js';
import { getLPClient } from './lpClient.js';
import { saveActiveSwap, updateSwapState, clearActiveSwap, saveToHistory } from './storage.js';
import { keccak256, toHex, parseEther } from 'https://esm.sh/viem@2.7.0';

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

        await this.getQuote();
        await this.initializeAgent();
        await this.checkOracleFreshness();
        await this.initiateOnEVM();
        await this.notifyLP();
        await this.waitForLPReady();
        await this.finalize();
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

        updateSwapState({
            moneroAddress: agentData.moneroAddress,
            commitment: agentData.commitment
        });
    }

    async checkOracleFreshness() {
        console.log('Checking oracle freshness...');
        
        try {
            await readHub('getXmrPriceWithAge', [110n]);
            console.log('✅ Oracle prices are fresh');
        } catch (error) {
            if (error.message && error.message.includes('StalePrice')) {
                console.warn('⚠️ Oracle prices stale, waiting 10s...');
                await new Promise(resolve => setTimeout(resolve, 10000));
                
                try {
                    await readHub('getXmrPriceWithAge', [110n]);
                    console.log('✅ Oracle prices refreshed');
                } catch (retryError) {
                    throw new Error('Oracle stale — please retry in a moment. The LP server price pusher may be behind.');
                }
            } else {
                throw error;
            }
        }
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
            timeoutDuration: this.timeoutDuration,
            griefingDeposit: this.griefingDeposit.toString()
        });

        const receipt = await writeHub(
            'initiateMint',
            [
                this.lpVault,
                userAddress,
                this.wsxmrAmount,
                commitment,
                BigInt(this.timeoutDuration)
            ],
            this.griefingDeposit
        );

        console.log('Mint initiated, tx:', receipt.transactionHash);

        const mintInitiatedEvent = receipt.logs.find(log => 
            log.topics[0] === keccak256(toHex('MintInitiated(bytes32,address,address,address,uint256,uint256,uint256,bytes32,uint256)'))
        );

        if (mintInitiatedEvent) {
            this.requestId = mintInitiatedEvent.topics[1];
            console.log('Request ID:', this.requestId);
            
            updateSwapState({
                requestId: this.requestId,
                txHash: receipt.transactionHash
            });
        } else {
            throw new Error('Could not extract requestId from transaction');
        }

        this.state = 'initiated';
    }

    async notifyLP() {
        console.log('Notifying LP server...');
        
        try {
            const response = await this.lpClient.notifyMint({
                requestId: this.requestId,
                txHash: updateSwapState.txHash
            });

            this.depositAddress = response.deposit_address;
            console.log('LP notified, deposit address:', this.depositAddress);
            
            updateSwapState({
                state: 'deposit',
                depositAddress: this.depositAddress
            });
        } catch (error) {
            console.warn('LP server notification failed:', error);
            console.log('User must send XMR manually and wait for LP to detect it');
            
            updateSwapState({
                state: 'deposit',
                depositAddress: 'MANUAL_DEPOSIT_REQUIRED'
            });
        }

        this.state = 'deposit';
    }

    async waitForLPReady() {
        this.state = 'lp-ready';
        updateSwapState({ state: this.state });

        console.log('Waiting for LP to call setMintReady...');

        const pollStatus = async () => {
            try {
                const status = await this.lpClient.getMintStatus(this.requestId);
                console.log('Mint status:', status);
                
                if (status.status === 'READY') {
                    return true;
                }
                
                updateSwapState({
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
                'MintReady',
                { requestId: this.requestId },
                (log) => {
                    console.log('MintReady event received');
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
                reject(new Error('LP ready timeout'));
            }, 1800000);
        });
    }

    async finalize() {
        this.state = 'finalize';
        updateSwapState({ state: this.state });

        console.log('Finalizing mint...');

        const secret = this.agent.getSecret();
        
        const receipt = await writeHub('finalizeMint', [this.requestId, secret]);
        
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
        await this.agent.initialize('MINT', this.xmrAmount.toString());

        switch (this.state) {
            case 'deposit':
            case 'lp-ready':
                await this.waitForLPReady();
                await this.finalize();
                break;
            case 'finalize':
                await this.finalize();
                break;
            default:
                throw new Error('Cannot resume from state: ' + this.state);
        }
    }
}
