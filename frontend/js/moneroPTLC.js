// Monero PTLC (Point Time Locked Contract) Transaction Builder
// Handles creation and claiming of PTLCs for atomic swaps

import { keccak256, toHex, hexToBytes } from 'https://esm.sh/viem@2.7.0';
import { Point } from 'https://esm.sh/noble-ed25519@2.0.0';

/**
 * PTLC Transaction Builder for Monero
 * 
 * A PTLC is a Monero transaction output that can be spent by revealing a secret
 * that corresponds to an Ed25519 point (commitment).
 * 
 * Structure:
 * - Standard Monero output with additional data in tx_extra
 * - tx_extra contains the Ed25519 point commitment (keccak256 hash)
 * - To claim: provide secret s such that keccak256(G*s) = commitment
 */
class MoneroPTLCBuilder {
    constructor(moneroWallet, rpcClient) {
        this.wallet = moneroWallet;
        this.rpc = rpcClient;
    }

    /**
     * Scan for PTLC output with matching commitment (secretHash)
     * @param {string} commitment - Ed25519 commitment (keccak256 hash of public key)
     * @param {number} startHeight - Block height to start scanning from
     * @returns {Object} PTLC details if found
     */
    async scanForPTLC(commitment, startHeight = null) {
        console.log('Scanning for PTLC with commitment:', commitment);

        const currentHeight = await this.rpc.getHeight();
        const scanStart = startHeight || (currentHeight - 100);

        console.log(`Scanning blocks ${scanStart} to ${currentHeight}`);

        // Scan blocks for transactions with PTLC marker in tx_extra
        for (let height = scanStart; height <= currentHeight; height++) {
            try {
                const block = await this.rpc.getBlock(height);
                
                if (!block || !block.tx_hashes) continue;

                // Check each transaction in the block
                for (const txHash of block.tx_hashes) {
                    const tx = await this.rpc.getTransaction(txHash);
                    
                    if (!tx) continue;

                    // Parse tx_extra for PTLC marker
                    const ptlcData = this.parsePTLCFromTxExtra(tx.extra);
                    
                    if (ptlcData && ptlcData.commitment === commitment) {
                        console.log('Found PTLC!', {
                            txHash,
                            height,
                            commitment: ptlcData.commitment
                        });

                        // Get output details
                        const outputs = await this.findPTLCOutputs(tx, commitment);

                        return {
                            txHash,
                            height,
                            commitment: ptlcData.commitment,
                            lockTime: ptlcData.lockTime,
                            outputs,
                            rawTx: tx
                        };
                    }
                }
            } catch (error) {
                console.error(`Error scanning block ${height}:`, error);
            }
        }

        console.log('PTLC not found in scanned range');
        return null;
    }

    /**
     * Parse PTLC data from transaction extra field
     * PTLC marker format in tx_extra:
     * - Tag: 0xDE (PTLC marker)
     * - Commitment: 32 bytes (Ed25519 commitment hash)
     * - Lock time: 4 bytes (block height)
     */
    parsePTLCFromTxExtra(txExtra) {
        if (!txExtra) return null;

        const extraBytes = typeof txExtra === 'string' ? hexToBytes(txExtra) : txExtra;
        
        // Look for PTLC marker (0xDE)
        const PTLC_MARKER = 0xDE;
        
        for (let i = 0; i < extraBytes.length - 37; i++) {
            if (extraBytes[i] === PTLC_MARKER) {
                // Found marker, extract commitment and lock time
                const commitment = toHex(extraBytes.slice(i + 1, i + 33));
                const lockTimeBytes = extraBytes.slice(i + 33, i + 37);
                const lockTime = new DataView(lockTimeBytes.buffer).getUint32(0, true);

                return {
                    commitment,
                    lockTime
                };
            }
        }

        return null;
    }

    /**
     * Find outputs belonging to this PTLC
     * Uses wallet's view key to check which outputs are ours
     */
    async findPTLCOutputs(tx, commitment) {
        // In a real implementation, this would:
        // 1. Use wallet's private view key to decrypt output amounts
        // 2. Check if output public key can be derived from our address
        // 3. Return list of outputs we can spend

        // For now, return placeholder
        return [{
            index: 0,
            amount: 0, // Encrypted in RingCT
            publicKey: null
        }];
    }

    /**
     * Build transaction to claim PTLC
     * @param {Object} ptlc - PTLC details from scanForPTLC
     * @param {string} secret - Secret that satisfies G*s = commitment
     * @param {string} destinationAddress - Where to send claimed XMR
     * @returns {Object} Signed transaction ready to broadcast
     */
    async buildClaimTransaction(ptlc, secret, destinationAddress) {
        console.log('Building PTLC claim transaction');
        console.log('PTLC:', ptlc.txHash);
        console.log('Secret:', secret);
        console.log('Destination:', destinationAddress);

        // Verify secret matches commitment
        if (!this.verifySecret(secret, ptlc.commitment)) {
            throw new Error('Secret does not match PTLC commitment');
        }

        // Get wallet's private spend key
        const privateSpendKey = await this.wallet.getPrivateSpendKey();
        const privateViewKey = await this.wallet.getPrivateViewKey();

        // Build Monero transaction
        const tx = await this.buildMoneroTransaction({
            inputs: ptlc.outputs,
            destination: destinationAddress,
            amount: ptlc.outputs[0].amount, // Total amount from PTLC
            privateSpendKey,
            privateViewKey,
            secret, // Include secret in transaction
            ptlcCommitment: ptlc.commitment
        });

        return tx;
    }

    /**
     * Verify that secret satisfies the PTLC commitment
     * Check: keccak256(abi.encodePacked(px, py)) = commitment where (px, py) = G * secret on Ed25519
     */
    verifySecret(secret, commitment) {
        try {
            // Convert secret to BigInt
            const secretBigInt = BigInt(secret);
            
            // Ed25519 group order
            const ED25519_L = 2n**252n + 27742317777372353535851937790883648493n;
            
            // Reduce secret modulo group order
            const secretReduced = secretBigInt % ED25519_L;
            
            // Generate Ed25519 public key: P = secret * G
            const publicKeyPoint = Point.BASE.multiply(secretReduced);
            
            // Get raw bytes of the public key point
            const publicKeyBytes = publicKeyPoint.toRawBytes();
            
            // Convert to hex
            const publicKeyHex = toHex(publicKeyBytes);
            
            // Extract x and y coordinates (32 bytes each)
            const px = publicKeyHex.slice(0, 66);
            const py = '0x' + publicKeyHex.slice(66);
            
            // Compute commitment as keccak256(abi.encodePacked(px, py))
            const computedCommitment = keccak256(px + py.slice(2));
            
            // Compare commitments
            return computedCommitment.toLowerCase() === commitment.toLowerCase();
        } catch (error) {
            console.error('Error verifying secret:', error);
            return false;
        }
    }

    /**
     * Build Monero transaction with PTLC claim
     * This is the core transaction building logic
     */
    async buildMoneroTransaction(params) {
        const {
            inputs,
            destination,
            amount,
            privateSpendKey,
            privateViewKey,
            secret,
            ptlcCommitment
        } = params;

        console.log('Building Monero transaction with parameters:', {
            destination,
            amount,
            inputCount: inputs.length
        });

        // Step 1: Create transaction prefix
        const txPrefix = this.createTransactionPrefix({
            inputs,
            destination,
            amount
        });

        // Step 2: Create RingCT signature
        // This proves we can spend the inputs without revealing which ones
        const rctSignature = await this.createRingCTSignature({
            txPrefix,
            inputs,
            privateSpendKey,
            privateViewKey,
            secret, // Include secret in signature
            ptlcCommitment
        });

        // Step 3: Assemble complete transaction
        const completeTx = {
            version: 2, // RingCT version
            unlock_time: 0,
            vin: txPrefix.inputs,
            vout: txPrefix.outputs,
            extra: this.createTxExtra(secret, ptlcCommitment),
            rct_signatures: rctSignature
        };

        // Step 4: Serialize and return
        const serialized = this.serializeTransaction(completeTx);

        return {
            txData: completeTx,
            txBlob: serialized,
            txHash: this.hashTransaction(serialized)
        };
    }

    /**
     * Create transaction prefix (inputs and outputs)
     */
    createTransactionPrefix(params) {
        const { inputs, destination, amount } = params;

        // Create outputs
        const outputs = [{
            amount: 0, // Hidden in RingCT
            target: {
                key: this.deriveOutputKey(destination)
            }
        }];

        // Create inputs (references to PTLC outputs)
        const txInputs = inputs.map((input, index) => ({
            type: 'key',
            amount: 0, // Hidden in RingCT
            key_offsets: [input.index], // Simplified - real impl uses ring members
            k_image: this.generateKeyImage(input, index)
        }));

        return {
            inputs: txInputs,
            outputs: outputs
        };
    }

    /**
     * Create RingCT signature that includes secret reveal
     * This is where the PTLC claim happens - we prove we know the secret
     */
    async createRingCTSignature(params) {
        const {
            txPrefix,
            inputs,
            privateSpendKey,
            secret,
            ptlcCommitment
        } = params;

        // In a real implementation, this would:
        // 1. Create Bulletproofs for amount hiding
        // 2. Create MLSAG signatures for ring signatures
        // 3. Include secret reveal as part of signature
        // 4. Prove: "I know secret s such that G*s = commitment AND I can spend these outputs"

        console.log('Creating RingCT signature with secret reveal');

        // Placeholder structure
        return {
            type: 'RCTTypeFull',
            txnFee: 0,
            ecdhInfo: [], // Encrypted amounts
            outPk: [], // Output commitments
            p: {
                bulletproofs: [],
                MGs: [], // MLSAG signatures
                pseudoOuts: []
            },
            // PTLC-specific: Include secret reveal
            ptlcReveal: {
                secret: secret,
                commitment: ptlcCommitment,
                proof: this.createSecretProof(secret, ptlcCommitment)
            }
        };
    }

    /**
     * Create proof that secret matches commitment
     */
    createSecretProof(secret, commitment) {
        // Create zero-knowledge proof: "I know s such that keccak256(G*s) = commitment"
        // This is a Schnorr signature-like proof on Ed25519

        const secretBigInt = BigInt(secret);
        const ED25519_L = 2n**252n + 27742317777372353535851937790883648493n;
        
        // Generate random nonce
        const r = BigInt('0x' + Array.from(crypto.getRandomValues(new Uint8Array(32)))
            .map(b => b.toString(16).padStart(2, '0')).join(''));
        const rReduced = r % ED25519_L;
        
        // R = G*r on Ed25519
        const R = Point.BASE.multiply(rReduced);
        const RBytes = R.toRawBytes();

        // Challenge: e = H(R || commitment || message)
        const message = 'PTLC_CLAIM';
        const e = keccak256(toHex(RBytes) + commitment.slice(2) + toHex(message).slice(2));
        const eNum = BigInt(e);
        const sNum = secretBigInt % ED25519_L;

        // Response: s = r + e*secret (mod L)
        const response = (rReduced + eNum * sNum) % ED25519_L;

        return {
            R: toHex(RBytes),
            response: '0x' + response.toString(16).padStart(64, '0')
        };
    }

    /**
     * Create tx_extra field with secret reveal
     */
    createTxExtra(secret, commitment) {
        // tx_extra format:
        // - 0x01: TX_EXTRA_TAG_PUBKEY
        // - 32 bytes: transaction public key
        // - 0xDE: PTLC_CLAIM marker
        // - 32 bytes: revealed secret
        // - 32 bytes: commitment (for verification)

        const txPubKey = new Uint8Array(32); // Placeholder
        const secretBytes = hexToBytes(secret);
        const commitmentBytes = hexToBytes(commitment);

        const extra = new Uint8Array(1 + 32 + 1 + 32 + 32);
        extra[0] = 0x01; // TX_EXTRA_TAG_PUBKEY
        extra.set(txPubKey, 1);
        extra[33] = 0xDE; // PTLC_CLAIM marker
        extra.set(secretBytes, 34);
        extra.set(commitmentBytes.slice(0, 32), 66);

        return toHex(extra);
    }

    /**
     * Derive output public key for destination address
     */
    deriveOutputKey(address) {
        // In real implementation, this would:
        // 1. Decode the Monero address
        // 2. Extract public spend key and public view key
        // 3. Derive one-time output key using Diffie-Hellman

        // Placeholder
        return '0x' + '00'.repeat(32);
    }

    /**
     * Generate key image for input
     * Key image prevents double-spending
     */
    generateKeyImage(input, index) {
        // In real implementation:
        // keyImage = x * H_p(P)
        // where x is private key, P is public key, H_p is hash-to-point

        // Placeholder
        return '0x' + '00'.repeat(32);
    }

    /**
     * Serialize transaction to binary format
     */
    serializeTransaction(tx) {
        // In real implementation, this would serialize according to Monero's
        // binary format specification

        // Placeholder - return hex string
        return '0x' + '00'.repeat(100);
    }

    /**
     * Hash transaction to get transaction ID
     */
    hashTransaction(txBlob) {
        return keccak256(txBlob);
    }

    /**
     * Broadcast transaction to Monero network
     */
    async broadcastTransaction(txBlob) {
        console.log('Broadcasting PTLC claim transaction');

        try {
            const response = await this.rpc.daemonRpc('send_raw_transaction', {
                tx_as_hex: txBlob.slice(2) // Remove 0x prefix
            });

            if (response.status === 'OK') {
                return {
                    success: true,
                    txHash: this.hashTransaction(txBlob)
                };
            } else {
                throw new Error(`Broadcast failed: ${response.reason}`);
            }
        } catch (error) {
            console.error('Error broadcasting transaction:', error);
            throw error;
        }
    }
}

/**
 * Create PTLC builder instance
 */
export function createPTLCBuilder(moneroWallet, rpcClient) {
    return new MoneroPTLCBuilder(moneroWallet, rpcClient);
}

/**
 * High-level function to claim PTLC
 * @param {Object} moneroWallet - Monero wallet instance
 * @param {Object} rpcClient - Monero RPC client
 * @param {string} commitment - PTLC commitment (secretHash)
 * @param {string} secret - Revealed secret
 * @param {string} destinationAddress - Where to send claimed XMR
 */
export async function claimPTLC(moneroWallet, rpcClient, commitment, secret, destinationAddress) {
    const builder = createPTLCBuilder(moneroWallet, rpcClient);

    // Step 1: Find PTLC on chain
    console.log('Step 1: Scanning for PTLC...');
    const ptlc = await builder.scanForPTLC(commitment);
    
    if (!ptlc) {
        throw new Error('PTLC not found on Monero blockchain');
    }

    console.log('Found PTLC:', ptlc.txHash);

    // Step 2: Build claim transaction
    console.log('Step 2: Building claim transaction...');
    const claimTx = await builder.buildClaimTransaction(ptlc, secret, destinationAddress);

    console.log('Claim transaction built:', claimTx.txHash);

    // Step 3: Broadcast transaction
    console.log('Step 3: Broadcasting transaction...');
    const result = await builder.broadcastTransaction(claimTx.txBlob);

    console.log('PTLC claimed successfully!');
    return result;
}
