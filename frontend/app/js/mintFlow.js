// Mint Flow - XMR to wsXMR
// Handles the complete minting process

import { getPhantomAgent } from './phantomAgent.js';
import { writeVaultManager, readVaultManager, watchContractEvent, getPastEvents, getBlockNumber } from './viemClient.js';
import { getPriceUpdates, getPythUpdateFee } from './pythOracle.js';
import { saveActiveSwap, updateSwapState, clearActiveSwap, saveToHistory } from './storage.js';
import { SWAP_CONFIG, DECIMALS, CONTRACTS } from './config.js';
import { pad, toHex, parseEther } from 'https://esm.sh/viem@2.7.0';

/**
 * Mint Flow State Machine
 */
export class MintFlow {
    constructor() {
        this.state = 'idle';
        this.requestId = null;
        this.agent = null;
        this.lpVault = null;
        this.xmrAmount = null;
        this.griefingDeposit = null;
        this.timeout = null;
        this.eventWatchers = [];
    }

    /**
     * Start the mint flow
     * @param {string} lpVault - LP vault address
     * @param {number} xmrAmount - Amount in XMR (human-readable)
     */
    async start(lpVault, xmrAmount) {
        console.log('Starting mint flow:', { lpVault, xmrAmount });

        // Validate inputs
        if (xmrAmount < SWAP_CONFIG.minMintAmount) {
            throw new Error(`Minimum mint amount is ${SWAP_CONFIG.minMintAmount} XMR`);
        }

        this.lpVault = lpVault;
        this.xmrAmount = xmrAmount;
        this.timeoutDuration = SWAP_CONFIG.defaultTimeout; // Duration in seconds, not timestamp

        // Step 1: Initialize Phantom Agent (generate commitment)
        await this.initializeAgent();

        // Step 2: Initiate on EVM (call contract with commitment)
        await this.initiateOnEVM();

        // Step 3: Display deposit info and monitor (LP provides address, user deposits)
        await this.monitorDeposit();

        // Step 4: Wait for LP confirmation (LP confirms XMR lock)
        await this.waitForLPConfirmation();

        // Step 5: Wait for finalization (LP reveals secret)
        await this.waitForFinalization();
    }

    /**
     * Step 1: Initialize Phantom Agent
     */
    async initializeAgent() {
        this.state = 'init';
        updateSwapState({ 
            type: 'mint',
            state: this.state,
            lpVault: this.lpVault,
            xmrAmount: this.xmrAmount
        });

        this.agent = getPhantomAgent();
        
        const agentData = await this.agent.initialize(
            'MINT',
            this.xmrAmount.toString()
        );

        console.log('Agent initialized:', agentData);

        updateSwapState({
            state: 'deposit',
            moneroAddress: agentData.moneroAddress,
            commitment: agentData.commitment
        });

        this.state = 'deposit';
    }

    /**
     * Step 2: Monitor for XMR deposit
     * Note: This requires LP server with wallet RPC to actually scan the chain
     * Browser can only display the address and wait for LP confirmation
     */
    async monitorDeposit() {
        console.log('Monitoring for XMR deposit to:', this.agent.getMoneroAddress());

        // Convert XMR to atomic units (12 decimals)
        const expectedAmount = BigInt(Math.floor(this.xmrAmount * Math.pow(10, DECIMALS.XMR)));

        console.log('Expected amount:', expectedAmount.toString(), 'atomic units');
        console.log('Waiting for LP server to detect deposit...');

        // In production, the LP server monitors the Monero chain
        // The browser just waits for the LP to confirm via EVM event
        return new Promise((resolve, reject) => {
            let pollInterval;
            let timeoutHandle;

            const checkDeposit = async () => {
                try {
                    // Try to scan for deposit (will fail in browser, succeed with LP server)
                    const moneroWallet = this.agent.moneroWallet;
                    if (moneroWallet && moneroWallet.scanForDeposit) {
                        try {
                            const currentHeight = await moneroWallet.getHeight();
                            const deposit = await moneroWallet.scanForDeposit(
                                expectedAmount,
                                currentHeight - 10 // Scan last 10 blocks
                            );
                            
                            if (deposit) {
                                console.log('Deposit detected:', deposit);
                                clearInterval(pollInterval);
                                clearTimeout(timeoutHandle);
                                resolve();
                                return;
                            }
                        } catch (scanError) {
                            // Expected to fail in browser - LP server handles this
                            console.log('Browser cannot scan chain - waiting for LP confirmation');
                        }
                    }

                    // Fallback: Check for LP confirmation via EVM event
                    // The LP will call confirmMint() when they see the deposit
                    // We can watch for the MintReady event
                } catch (error) {
                    console.error('Error monitoring deposit:', error);
                }
            };

            pollInterval = setInterval(checkDeposit, SWAP_CONFIG.pollInterval);
            
            // Initial check
            checkDeposit();

            // Timeout after 2 hours (MAX_MINT_TIMEOUT)
            timeoutHandle = setTimeout(() => {
                clearInterval(pollInterval);
                reject(new Error('Deposit timeout - no XMR received within 2 hours'));
            }, 7200000);
        });
    }

    /**
     * Step 3: Initiate mint on EVM
     */
    async initiateOnEVM() {
        this.state = 'evm-init';
        updateSwapState({ state: this.state });

        console.log('Initiating mint on EVM...');

        // Get vault info to determine griefing deposit
        const vaultInfo = await readVaultManager('getVault', [this.lpVault]);
        this.griefingDeposit = vaultInfo[4]; // mintGriefingDeposit

        console.log('Griefing deposit required:', this.griefingDeposit.toString());

        // Fetch Pyth price updates
        const { updateData } = await getPriceUpdates();
        const pythFee = await getPythUpdateFee(updateData, CONTRACTS.pythOracle);

        console.log('Pyth update fee:', pythFee.toString());

        // Convert XMR amount to contract format (8 decimals for wsXMR)
        const xmrAmountContract = BigInt(Math.floor(this.xmrAmount * Math.pow(10, DECIMALS.wsXMR)));

        // Get commitment from agent
        const commitment = this.agent.getCommitment();

        // Calculate total value to send (griefing deposit + pyth fee)
        const totalValue = this.griefingDeposit + pythFee;

        console.log('Initiating mint with params:', {
            lpVault: this.lpVault,
            xmrAmount: xmrAmountContract.toString(),
            commitment,
            timeoutDuration: this.timeoutDuration,
            value: totalValue.toString()
        });

        // First update Pyth prices
        await writeVaultManager('updatePythPrices', [updateData], pythFee);

        // Then initiate mint
        // Get user's address for recipient
        const { getUserAddress } = await import('./viemClient.js');
        const userAddress = getUserAddress();
        
        const receipt = await writeVaultManager(
            'initiateMint',
            [this.lpVault, userAddress, xmrAmountContract, commitment, BigInt(this.timeoutDuration)],
            this.griefingDeposit
        );

        console.log('Mint initiated, tx:', receipt.transactionHash);

        // Extract requestId from events
        // MintInitiated event signature: MintInitiated(bytes32 indexed requestId, address indexed initiator, address indexed recipient, address lpVault, uint256 xmrAmount, uint256 wsxmrAmount, uint256 feeAmount, bytes32 claimCommitment, uint256 timeout)
        const mintInitiatedEventSig = '0xb2dfbb26df226ffe3b99f8ca997b1758298208a9f9ba18dd035e3ee1539e6950';
        
        const mintInitiatedEvent = receipt.logs.find(log => {
            try {
                return log.topics[0] === mintInitiatedEventSig;
            } catch {
                return false;
            }
        });

        if (mintInitiatedEvent) {
            this.requestId = mintInitiatedEvent.topics[1]; // requestId is first indexed param
            console.log('Request ID:', this.requestId);
            
            updateSwapState({
                state: 'lp-confirm',
                requestId: this.requestId,
                txHash: receipt.transactionHash
            });
        } else {
            throw new Error('Could not extract requestId from transaction');
        }

        this.state = 'lp-confirm';
    }

    /**
     * Step 4: Wait for LP confirmation (MintReady event)
     */
    async waitForLPConfirmation() {
        console.log('Waiting for LP to confirm Monero lock...');

        return new Promise((resolve, reject) => {
            // Watch for MintReady event
            const unwatch = watchContractEvent(
                'MintReady',
                (logs) => {
                    for (const log of logs) {
                        const requestId = log.args.requestId;
                        if (requestId === this.requestId) {
                            console.log('LP confirmed! MintReady event received');
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
                reject(new Error('LP confirmation timeout'));
            }, 1800000);
        });
    }

    /**
     * Step 5: Wait for finalization (MintFinalized event)
     */
    async waitForFinalization() {
        this.state = 'finalize';
        updateSwapState({ state: this.state });

        console.log('Waiting for mint finalization...');

        return new Promise((resolve, reject) => {
            // Watch for MintFinalized event
            const unwatch = watchContractEvent(
                'MintFinalized',
                (logs) => {
                    for (const log of logs) {
                        const requestId = log.args.requestId;
                        if (requestId === this.requestId) {
                            console.log('Mint finalized! wsXMR minted to user');
                            unwatch();
                            this.complete();
                            resolve();
                        }
                    }
                }
            );

            this.eventWatchers.push(unwatch);

            // Timeout after 30 minutes
            setTimeout(() => {
                unwatch();
                reject(new Error('Finalization timeout'));
            }, 1800000);
        });
    }

    /**
     * Complete the mint flow
     */
    complete() {
        this.state = 'completed';
        
        // Save to history
        const swapData = {
            type: 'mint',
            requestId: this.requestId,
            lpVault: this.lpVault,
            xmrAmount: this.xmrAmount,
            moneroAddress: this.agent.getMoneroAddress(),
            state: 'completed'
        };
        
        saveToHistory(swapData);
        clearActiveSwap();
        
        // Cleanup
        this.cleanup();
        
        console.log('Mint flow completed successfully!');
    }

    /**
     * Cancel and refund
     */
    async cancel() {
        console.log('Canceling mint and refunding XMR...');

        // If we have XMR in the phantom wallet, send it back to user
        const balance = await this.agent.getMoneroBalance();
        
        if (balance > 0n) {
            // User needs to provide their Monero address for refund
            const destination = prompt('Enter your Monero address for refund:');
            
            if (destination) {
                await this.agent.sendMonero(destination, balance);
                console.log('XMR refunded to:', destination);
            }
        }

        // If we've already initiated on EVM, try to cancel
        if (this.requestId) {
            try {
                await writeVaultManager('cancelMint', [this.requestId]);
                console.log('Mint request canceled on EVM');
            } catch (error) {
                console.error('Error canceling mint on EVM:', error);
            }
        }

        clearActiveSwap();
        this.cleanup();
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
        console.log('Resuming mint flow from state:', savedState.state);

        this.lpVault = savedState.lpVault;
        this.xmrAmount = savedState.xmrAmount;
        this.requestId = savedState.requestId;
        this.state = savedState.state;

        // Re-initialize agent
        this.agent = getPhantomAgent();
        
        // User needs to sign again to restore the agent
        await this.agent.initialize('MINT', this.xmrAmount.toString());

        // Resume from current state
        switch (this.state) {
            case 'deposit':
                await this.monitorDeposit();
                await this.initiateOnEVM();
                await this.waitForLPConfirmation();
                await this.waitForFinalization();
                break;
            case 'evm-init':
                await this.initiateOnEVM();
                await this.waitForLPConfirmation();
                await this.waitForFinalization();
                break;
            case 'lp-confirm':
                await this.waitForLPConfirmation();
                await this.waitForFinalization();
                break;
            case 'finalize':
                await this.waitForFinalization();
                break;
            default:
                throw new Error('Cannot resume from state: ' + this.state);
        }
    }
}
