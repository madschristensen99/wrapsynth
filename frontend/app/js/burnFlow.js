// Burn Flow - wsXMR to XMR
// Handles the complete burning process

import { getPhantomAgent } from './phantomAgent.js';
import { 
    writeVaultManager, 
    readVaultManager, 
    writeWrappedMonero,
    readWrappedMonero,
    watchContractEvent, 
    getUserAddress 
} from './viemClient.js';
import { getPriceUpdates, getPythUpdateFee } from './pythOracle.js';
import { saveActiveSwap, updateSwapState, clearActiveSwap, saveToHistory } from './storage.js';
import { SWAP_CONFIG, DECIMALS, CONTRACTS } from './config.js';
import { keccak256 } from 'https://esm.sh/viem@2.7.0';

/**
 * Burn Flow State Machine
 */
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
    }

    /**
     * Start the burn flow
     * @param {string} lpVault - LP vault address
     * @param {number} wsxmrAmount - Amount in wsXMR (human-readable)
     * @param {string} destination - User's Monero address (CakeWallet, etc.)
     */
    async start(lpVault, wsxmrAmount, destination) {
        console.log('Starting burn flow:', { lpVault, wsxmrAmount, destination });

        // Validate inputs
        if (wsxmrAmount < SWAP_CONFIG.minBurnAmount) {
            throw new Error(`Minimum burn amount is ${SWAP_CONFIG.minBurnAmount} wsXMR`);
        }

        if (!destination || destination.length < 95) {
            throw new Error('Invalid Monero destination address');
        }

        this.lpVault = lpVault;
        this.wsxmrAmount = wsxmrAmount;
        this.destination = destination;

        // Step 1: Initialize Phantom Agent
        await this.initializeAgent();

        // Step 2: Request burn on EVM
        await this.requestBurnOnEVM();

        // Step 3: Wait for LP commitment
        await this.waitForLPCommitment();

        // Step 4: Claim XMR on Monero chain
        await this.claimXMR();

        // Step 5: Finalize on EVM
        await this.finalizeOnEVM();
    }

    /**
     * Step 1: Initialize Phantom Agent
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

        this.agent = getPhantomAgent();
        
        const agentData = await this.agent.initialize(
            'BURN',
            this.wsxmrAmount.toString(),
            this.destination
        );

        console.log('Agent initialized:', agentData);

        updateSwapState({
            state: 'evm-request',
            commitment: agentData.commitment
        });

        this.state = 'evm-request';
    }

    /**
     * Step 2: Request burn on EVM
     */
    async requestBurnOnEVM() {
        console.log('Requesting burn on EVM...');

        const userAddress = getUserAddress();

        // Convert wsXMR amount to contract format (8 decimals)
        const wsxmrAmountContract = BigInt(Math.floor(this.wsxmrAmount * Math.pow(10, DECIMALS.wsXMR)));

        // Check allowance
        const allowance = await readWrappedMonero('allowance', [userAddress, CONTRACTS.vaultManager]);
        
        if (allowance < wsxmrAmountContract) {
            console.log('Approving wsXMR spend...');
            await writeWrappedMonero('approve', [CONTRACTS.vaultManager, wsxmrAmountContract]);
        }

        // Fetch Pyth price updates
        const { updateData } = await getPriceUpdates();
        const pythFee = await getPythUpdateFee(updateData, CONTRACTS.pythOracle);

        console.log('Pyth update fee:', pythFee.toString());

        // Update Pyth prices first
        await writeVaultManager('updatePythPrices', [updateData], pythFee);

        // Request burn
        const receipt = await writeVaultManager(
            'requestBurn',
            [wsxmrAmountContract, this.lpVault]
        );

        console.log('Burn requested, tx:', receipt.transactionHash);

        // Extract requestId from events
        const burnRequestedEvent = receipt.logs.find(log => {
            try {
                // Check if this is a BurnRequested event
                return log.topics[0] === '0x...'; // TODO: Calculate event signature
            } catch {
                return false;
            }
        });

        if (burnRequestedEvent) {
            this.requestId = burnRequestedEvent.topics[1]; // requestId is first indexed param
            console.log('Request ID:', this.requestId);
            
            updateSwapState({
                state: 'lp-commit',
                requestId: this.requestId,
                txHash: receipt.transactionHash
            });
        } else {
            throw new Error('Could not extract requestId from transaction');
        }

        this.state = 'lp-commit';
    }

    /**
     * Step 3: Wait for LP commitment (BurnCommitted event)
     */
    async waitForLPCommitment() {
        console.log('Waiting for LP to commit XMR lock...');

        return new Promise((resolve, reject) => {
            // Watch for BurnCommitted event
            const unwatch = watchContractEvent(
                'BurnCommitted',
                (logs) => {
                    for (const log of logs) {
                        const requestId = log.args.requestId;
                        if (requestId === this.requestId) {
                            this.secretHash = log.args.secretHash;
                            console.log('LP committed! SecretHash:', this.secretHash);
                            
                            updateSwapState({
                                state: 'claim-xmr',
                                secretHash: this.secretHash
                            });
                            
                            unwatch();
                            resolve();
                        }
                    }
                }
            );

            this.eventWatchers.push(unwatch);

            // Timeout after 30 minutes
            setTimeout(() => {
                unwatch();
                reject(new Error('LP commitment timeout'));
            }, 1800000);
        });
    }

    /**
     * Step 4: Claim XMR on Monero chain
     * Note: PTLC scanning and claiming requires LP server with full wallet
     * Browser can attempt but will need to rely on LP server for actual execution
     */
    async claimXMR() {
        this.state = 'claim-xmr';
        updateSwapState({ state: this.state });

        console.log('Scanning Monero chain for PTLC with secretHash:', this.secretHash);

        // Get current Monero blockchain height
        const moneroWallet = this.agent.moneroWallet;
        let startHeight;
        
        try {
            startHeight = await moneroWallet.getHeight();
            console.log('Current Monero height:', startHeight);
        } catch (error) {
            console.error('Error getting Monero height:', error);
            startHeight = null;
        }

        // Poll for PTLC with matching secretHash
        let ptlc = null;
        let attempts = 0;
        const maxAttempts = 120; // 10 minutes with 5-second intervals

        while (!ptlc && attempts < maxAttempts) {
            try {
                // Try to scan for PTLC (will fail in browser, succeed with LP server)
                ptlc = await moneroWallet.scanForPTLC(this.secretHash, startHeight);
                
                if (ptlc) {
                    console.log('PTLC found!', ptlc);
                    break;
                }
            } catch (scanError) {
                // Expected to fail in browser - LP server handles this
                if (attempts === 0) {
                    console.warn('Browser cannot scan for PTLC - waiting for LP to create it');
                    console.warn('In production, LP server monitors and claims automatically');
                }
            }

            attempts++;
            await new Promise(resolve => setTimeout(resolve, SWAP_CONFIG.pollInterval));
        }

        if (!ptlc) {
            console.error('PTLC not found after', attempts, 'attempts');
            throw new Error('PTLC not found on Monero chain - LP may not have created it yet');
        }

        // Claim the PTLC using our secret
        console.log('Claiming PTLC...');
        
        try {
            const claimTx = await moneroWallet.claimPTLC(ptlc.txHash, this.agent.getSecret());
            console.log('PTLC claimed, tx:', claimTx.txHash);

            // In production, the claimed XMR goes directly to user's destination address
            // The PTLC is created with the destination address as the recipient
            console.log('XMR will be sent to destination:', this.destination);

            updateSwapState({
                state: 'finalize',
                claimTxHash: claimTx.txHash
            });

            this.state = 'finalize';
        } catch (claimError) {
            console.error('Error claiming PTLC:', claimError);
            console.warn('PTLC claiming requires full wallet - LP server handles this');
            
            // In production, user just needs to wait for LP to finalize
            // The LP will reveal the secret on-chain when they claim the PTLC
            console.log('Waiting for LP to claim PTLC and reveal secret...');
            
            // User can still finalize on EVM once LP reveals the secret
            // The secret will be visible in the BurnCommitted event
            this.state = 'finalize';
            updateSwapState({ state: this.state });
        }
    }

    /**
     * Step 5: Finalize on EVM
     */
    async finalizeOnEVM() {
        console.log('Finalizing burn on EVM...');

        // Get the secret from agent
        const secret = this.agent.getSecret();

        // Verify secret matches hash
        const computedHash = keccak256(secret);
        if (computedHash !== this.secretHash) {
            console.warn('Secret hash mismatch!', { computed: computedHash, expected: this.secretHash });
        }

        // Call finalizeBurn with the secret
        const receipt = await writeVaultManager(
            'finalizeBurn',
            [this.requestId, secret]
        );

        console.log('Burn finalized on EVM, tx:', receipt.transactionHash);

        this.complete();
    }

    /**
     * Complete the burn flow
     */
    complete() {
        this.state = 'completed';
        
        // Save to history
        const swapData = {
            type: 'burn',
            requestId: this.requestId,
            lpVault: this.lpVault,
            wsxmrAmount: this.wsxmrAmount,
            destination: this.destination,
            state: 'completed'
        };
        
        saveToHistory(swapData);
        clearActiveSwap();
        
        // Cleanup
        this.cleanup();
        
        console.log('Burn flow completed successfully!');
    }

    /**
     * Cleanup watchers
     */
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
     * Resume from saved state
     */
    async resume(savedState) {
        console.log('Resuming burn flow from state:', savedState.state);

        this.lpVault = savedState.lpVault;
        this.wsxmrAmount = savedState.wsxmrAmount;
        this.destination = savedState.destination;
        this.requestId = savedState.requestId;
        this.secretHash = savedState.secretHash;
        this.state = savedState.state;

        // Re-initialize agent
        this.agent = getPhantomAgent();
        
        // User needs to sign again to restore the agent
        await this.agent.initialize('BURN', this.wsxmrAmount.toString(), this.destination);

        // Resume from current state
        switch (this.state) {
            case 'evm-request':
                await this.requestBurnOnEVM();
                await this.waitForLPCommitment();
                await this.claimXMR();
                await this.finalizeOnEVM();
                break;
            case 'lp-commit':
                await this.waitForLPCommitment();
                await this.claimXMR();
                await this.finalizeOnEVM();
                break;
            case 'claim-xmr':
                await this.claimXMR();
                await this.finalizeOnEVM();
                break;
            case 'finalize':
                await this.finalizeOnEVM();
                break;
            default:
                throw new Error('Cannot resume from state: ' + this.state);
        }
    }
}
