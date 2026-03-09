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
     * @param {string} destination - User's final Monero address (CakeWallet, etc.)
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

        // Step 1: Initialize Phantom Agent (generates ephemeral Monero wallet)
        await this.initializeAgent();

        // Step 2: Request burn on EVM
        await this.requestBurnOnEVM();

        // Step 3: Wait for LP to propose secretHash (LP creates PTLC on Monero)
        await this.waitForLPProposal();

        // Step 4: User confirms Monero PTLC is valid
        await this.confirmMoneroLock();

        // Step 5: Wait for LP to reveal secret on EVM
        await this.waitForSecretReveal();

        // Step 6: Claim PTLC on Monero using revealed secret
        await this.claimPTLC();

        // Step 7: Forward XMR to user's destination address
        await this.forwardToDestination();
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
     * Step 3: Wait for LP to propose secretHash (HashProposed event)
     * LP creates PTLC on Monero and proposes the hash on EVM
     */
    async waitForLPProposal() {
        console.log('Waiting for LP to propose secretHash...');

        return new Promise((resolve, reject) => {
            // Watch for HashProposed event
            const unwatch = watchContractEvent(
                'HashProposed',
                (logs) => {
                    for (const log of logs) {
                        const requestId = log.args.requestId;
                        if (requestId === this.requestId) {
                            this.secretHash = log.args.secretHash;
                            console.log('LP proposed secretHash:', this.secretHash);
                            console.log('Ephemeral Monero address:', this.agent.getMoneroAddress());
                            console.log('User should verify PTLC on Monero chain before confirming');
                            
                            updateSwapState({
                                state: 'verify-ptlc',
                                secretHash: this.secretHash,
                                ephemeralAddress: this.agent.getMoneroAddress()
                            });
                            
                            unwatch();
                            resolve();
                        }
                    }
                }
            );

            this.eventWatchers.push(unwatch);

            // Timeout after 1 hour (BURN_REQUEST_TIMEOUT)
            setTimeout(() => {
                unwatch();
                reject(new Error('LP proposal timeout - LP did not create PTLC'));
            }, 3600000);
        });
    }

    /**
     * Step 4: User confirms Monero PTLC is valid
     * User checks Monero blockchain to verify LP created valid PTLC
     */
    async confirmMoneroLock() {
        this.state = 'confirm-lock';
        updateSwapState({ state: this.state });

        console.log('User should verify PTLC on Monero blockchain:');
        console.log('- Check that PTLC exists with secretHash:', this.secretHash);
        console.log('- Verify amount matches:', this.wsxmrAmount, 'wsXMR');
        console.log('- Confirm PTLC recipient is ephemeral address:', this.agent.getMoneroAddress());
        
        // In production UI, show user the PTLC details and ask them to confirm
        // For now, we'll call confirmMoneroLock on the contract
        
        console.log('Calling confirmMoneroLock on contract...');
        const receipt = await writeVaultManager(
            'confirmMoneroLock',
            [this.requestId]
        );

        console.log('Monero lock confirmed, tx:', receipt.transactionHash);
        
        updateSwapState({
            state: 'wait-secret',
            confirmTxHash: receipt.transactionHash
        });

        this.state = 'wait-secret';
    }

    /**
     * Step 5: Wait for LP to reveal secret (BurnFinalized event)
     * LP must reveal secret within BURN_COMMIT_TIMEOUT or get slashed
     */
    async waitForSecretReveal() {
        console.log('Waiting for LP to reveal secret...');

        return new Promise((resolve, reject) => {
            // Watch for BurnFinalized event (contains revealed secret)
            const unwatch = watchContractEvent(
                'BurnFinalized',
                (logs) => {
                    for (const log of logs) {
                        const requestId = log.args.requestId;
                        if (requestId === this.requestId) {
                            const revealedSecret = log.args.secret;
                            console.log('LP revealed secret:', revealedSecret);
                            
                            // Store the revealed secret
                            this.revealedSecret = revealedSecret;
                            
                            updateSwapState({
                                state: 'claim-ptlc',
                                revealedSecret: revealedSecret
                            });
                            
                            unwatch();
                            resolve();
                        }
                    }
                }
            );

            this.eventWatchers.push(unwatch);

            // Timeout after 2 hours (BURN_COMMIT_TIMEOUT)
            setTimeout(() => {
                unwatch();
                reject(new Error('LP did not reveal secret - can claim slashed collateral'));
            }, 7200000);
        });
    }

    /**
     * Step 6: Claim PTLC on Monero using revealed secret
     */
    async claimPTLC() {
        this.state = 'claim-ptlc';
        updateSwapState({ state: this.state });

        console.log('Claiming PTLC on Monero with revealed secret...');
        console.log('Ephemeral wallet address:', this.agent.getMoneroAddress());
        console.log('Using secret:', this.revealedSecret);

        const moneroWallet = this.agent.moneroWallet;
        
        // Claim PTLC using the revealed secret
        // This transfers XMR from PTLC to ephemeral wallet
        try {
            const claimTx = await moneroWallet.claimPTLC(this.secretHash, this.revealedSecret);
            console.log('PTLC claimed! TX:', claimTx.txHash);
            console.log('XMR now in ephemeral wallet');

            updateSwapState({
                state: 'forward-xmr',
                claimTxHash: claimTx.txHash
            });

            this.state = 'forward-xmr';
        } catch (claimError) {
            console.error('Error claiming PTLC:', claimError);
            throw new Error('Failed to claim PTLC - browser needs Monero wallet functionality');
        }
    }

    /**
     * Step 7: Forward XMR from ephemeral wallet to user's destination address
     */
    async forwardToDestination() {
        this.state = 'forward-xmr';
        updateSwapState({ state: this.state });

        console.log('Forwarding XMR to destination:', this.destination);

        const moneroWallet = this.agent.moneroWallet;
        
        // Calculate amount in atomic units
        const xmrAtomicUnits = BigInt(Math.floor(
            this.wsxmrAmount * Math.pow(10, DECIMALS.XMR)
        ));

        try {
            const forwardTx = await moneroWallet.sendTransaction(
                this.destination,
                xmrAtomicUnits
            );
            
            console.log('XMR forwarded! TX:', forwardTx.txHash);
            console.log('Burn complete - XMR sent to:', this.destination);

            updateSwapState({
                state: 'complete',
                forwardTxHash: forwardTx.txHash
            });

            this.state = 'complete';
        } catch (forwardError) {
            console.error('Error forwarding XMR:', forwardError);
            throw new Error('Failed to forward XMR - browser needs Monero wallet functionality');
        }
    }

    /**
     * Note: finalizeBurn is called by the LP, not the user
     * LP calls it to reveal the secret and unlock their collateral
     * User doesn't need to do anything on EVM after confirming the lock

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
