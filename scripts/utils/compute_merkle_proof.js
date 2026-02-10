const axios = require('axios');
const crypto = require('crypto');
const { keccak_256 } = require('js-sha3');

// Monero RPC endpoint
const MONERO_RPC = process.env.MONERO_RPC_URL || 'http://node.moneroworld.com:18089/json_rpc';

/**
 * Compute Merkle proof for a transaction in a block
 */
async function computeTxMerkleProof(blockHeight, txHash) {
    console.log(`\nComputing Merkle proof for TX ${txHash} in block ${blockHeight}...`);
    
    // 1. Get block data
    const blockResponse = await axios.post(MONERO_RPC, {
        jsonrpc: '2.0',
        id: '0',
        method: 'get_block',
        params: {
            height: blockHeight
        }
    });
    
    if (blockResponse.data.error) {
        throw new Error(`Failed to get block: ${blockResponse.data.error.message}`);
    }
    
    const block = blockResponse.data.result;
    // NOTE: Oracle does NOT include miner TX in TX Merkle tree
    const txHashes = block.tx_hashes;
    
    console.log(`  Block has ${txHashes.length} transactions`);
    
    // 2. Find transaction index
    // Normalize txHash to remove 0x prefix if present
    const normalizedTxHash = txHash.startsWith('0x') ? txHash.slice(2) : txHash;
    const txIndex = txHashes.findIndex(hash => hash === normalizedTxHash);
    if (txIndex === -1) {
        throw new Error(`Transaction ${txHash} not found in block ${blockHeight}`);
    }
    
    console.log(`  Transaction found at index ${txIndex}`);
    
    // 3. Build Merkle tree and compute proof
    const proof = computeMerkleProofFromLeaves(txHashes, txIndex);
    
    console.log(`  Merkle proof has ${proof.length} siblings`);
    
    return {
        txIndex,
        proof,
        txHashes
    };
}

/**
 * Compute Merkle proof from list of leaves
 * Matches oracle implementation: uses SHA256 and duplicates last hash for odd numbers
 */
function computeMerkleProofFromLeaves(leaves, targetIndex) {
    const { keccak256: ethersKeccak256, concat } = require('ethers');
    const proof = [];
    let currentLevel = leaves.map(leaf => '0x' + leaf);
    let currentIndex = targetIndex;
    
    while (currentLevel.length > 1) {
        const nextLevel = [];
        
        for (let i = 0; i < currentLevel.length; i += 2) {
            const left = currentLevel[i];
            // Duplicate last hash for odd number (matches oracle)
            const right = i + 1 < currentLevel.length ? currentLevel[i + 1] : left;
            
            // If this pair contains our target, save the sibling
            if (i === currentIndex || i + 1 === currentIndex) {
                const sibling = (i === currentIndex) ? right : left;
                proof.push(sibling);
            }
            
            // Hash pair using Ethereum's keccak256 (matches Solidity abi.encodePacked)
            const hash = ethersKeccak256(concat([left, right]));
            nextLevel.push(hash);
        }
        
        // Move to next level
        currentLevel = nextLevel;
        currentIndex = Math.floor(currentIndex / 2);
    }
    
    return proof;
}

/**
 * Compute output Merkle proof
 */
async function computeOutputMerkleProof(blockHeight, txHash, outputIndex) {
    console.log(`\nComputing output Merkle proof for output ${outputIndex} in TX ${txHash}...`);
    
    // 1. Get block data to get all transaction hashes
    const blockResponse = await axios.post(MONERO_RPC, {
        jsonrpc: '2.0',
        id: '0',
        method: 'get_block',
        params: { height: blockHeight }
    });
    
    if (blockResponse.data.error) {
        throw new Error(`Failed to get block: ${blockResponse.data.error.message}`);
    }
    
    const block = blockResponse.data.result;
    const allTxHashes = block.tx_hashes || [];
    
    if (allTxHashes.length === 0) {
        console.log(`  No transactions in block`);
        return { outputIndex: 0, proof: [] };
    }
    
    console.log(`  Block has ${allTxHashes.length} transactions`);
    console.log(`  Fetching transaction details...`);
    
    // 2. Fetch all transactions using REST API endpoint
    const rpcUrl = MONERO_RPC.replace('/json_rpc', '');
    const txResponse = await axios.post(`${rpcUrl}/get_transactions`, {
        txs_hashes: allTxHashes,
        decode_as_json: true
    });
    
    if (txResponse.data.status !== 'OK') {
        throw new Error(`Failed to get transactions: ${txResponse.data.status}`);
    }
    
    const transactions = txResponse.data.txs || [];
    console.log(`  Fetched ${transactions.length} transactions`);
    
    // 3. Extract all outputs from all transactions
    const { keccak256: ethersKeccak256, concat, zeroPadValue, toBeHex } = require('ethers');
    const crypto = require('crypto');
    
    const allOutputs = [];
    let targetGlobalIndex = -1;
    let currentGlobalIndex = 0;
    
    // Normalize target TX hash
    const normalizedTargetTx = txHash.startsWith('0x') ? txHash.slice(2) : txHash;
    
    for (const tx of transactions) {
        const txJson = JSON.parse(tx.as_json);
        const currentTxHash = tx.tx_hash;
        
        const vout = txJson.vout || [];
        const rctSigs = txJson.rct_signatures || {};
        const ecdhInfo = rctSigs.ecdhInfo || [];
        const outPk = rctSigs.outPk || [];
        
        for (let i = 0; i < vout.length; i++) {
            const output = vout[i];
            
            // Extract output public key
            let outputPubKey;
            if (output.target?.key) {
                outputPubKey = output.target.key;
            } else if (output.target?.tagged_key?.key) {
                outputPubKey = output.target.tagged_key.key;
            } else {
                continue;
            }
            
            // Get ECDH amount and commitment
            const ecdhAmount = ecdhInfo[i]?.amount || '0'.repeat(16);
            const commitment = outPk[i] || '0'.repeat(64);
            
            // Create output data matching oracle format
            // IMPORTANT: Use GLOBAL output index, not local index i
            const outputData = {
                txHash: '0x' + currentTxHash,
                outputIndex: currentGlobalIndex,  // Use global index!
                ecdhAmount: '0x' + ecdhAmount.padStart(64, '0'),
                outputPubKey: '0x' + outputPubKey,
                commitment: '0x' + commitment
            };
            
            allOutputs.push(outputData);
            
            // Check if this is our target output
            if (currentTxHash === normalizedTargetTx && i === outputIndex) {
                targetGlobalIndex = currentGlobalIndex;
            }
            
            currentGlobalIndex++;
        }
    }
    
    if (targetGlobalIndex === -1) {
        throw new Error(`Output ${outputIndex} in TX ${txHash} not found in block`);
    }
    
    console.log(`  Total outputs in block: ${allOutputs.length}`);
    console.log(`  Target output global index: ${targetGlobalIndex}`);
    
    // 4. Build output Merkle tree using SHA256 (matches oracle)
    // Leaves are keccak256(abi.encodePacked(txHash, outputIndex, ecdhAmount, outputPubKey, commitment))
    
    const leaves = allOutputs.map(output => {
        // Pack data like Solidity's abi.encodePacked
        const packed = concat([
            output.txHash,
            zeroPadValue(toBeHex(output.outputIndex), 32),
            output.ecdhAmount,
            output.outputPubKey,
            output.commitment
        ]);
        return Buffer.from(ethersKeccak256(packed).slice(2), 'hex');
    });
    
    // 5. Compute Merkle proof using SHA256 for hashing
    const proof = [];
    let currentLevel = leaves;
    let currentIndex = targetGlobalIndex;
    
    while (currentLevel.length > 1) {
        const nextLevel = [];
        
        for (let i = 0; i < currentLevel.length; i += 2) {
            const left = currentLevel[i];
            const right = i + 1 < currentLevel.length ? currentLevel[i + 1] : left;
            
            // Save sibling for proof
            if (i === currentIndex || i + 1 === currentIndex) {
                const sibling = (i === currentIndex) ? right : left;
                proof.push('0x' + sibling.toString('hex'));
            }
            
            // Hash using SHA256 (matches oracle)
            const hasher = crypto.createHash('sha256');
            hasher.update(left);
            hasher.update(right);
            nextLevel.push(hasher.digest());
        }
        
        currentLevel = nextLevel;
        currentIndex = Math.floor(currentIndex / 2);
    }
    
    console.log(`  Output Merkle proof has ${proof.length} siblings`);
    
    // Debug: Verify proof by computing root
    let computedHash = leaves[targetGlobalIndex];
    let idx = targetGlobalIndex;
    for (let i = 0; i < proof.length; i++) {
        const sibling = Buffer.from(proof[i].slice(2), 'hex');
        const hasher = crypto.createHash('sha256');
        if (idx % 2 === 0) {
            hasher.update(computedHash);
            hasher.update(sibling);
        } else {
            hasher.update(sibling);
            hasher.update(computedHash);
        }
        computedHash = hasher.digest();
        idx = Math.floor(idx / 2);
    }
    const computedRoot = '0x' + computedHash.toString('hex');
    console.log(`  Computed root from proof: ${computedRoot}`);
    console.log(`  Expected root (from oracle): Check on-chain`);
    
    return {
        outputIndex: targetGlobalIndex,
        proof
    };
}

module.exports = {
    computeTxMerkleProof,
    computeOutputMerkleProof
};

// CLI usage
if (require.main === module) {
    const blockHeight = parseInt(process.argv[2]);
    const txHash = process.argv[3];
    const outputIndex = parseInt(process.argv[4] || '0');
    
    if (!blockHeight || !txHash) {
        console.log('Usage: node compute_merkle_proof.js <blockHeight> <txHash> [outputIndex]');
        process.exit(1);
    }
    
    (async () => {
        try {
            const txProof = await computeTxMerkleProof(blockHeight, txHash);
            console.log('\nTX Merkle Proof:');
            console.log('  Index:', txProof.txIndex);
            console.log('  Proof:', JSON.stringify(txProof.proof, null, 2));
            
            const outputProof = await computeOutputMerkleProof(txHash, outputIndex);
            console.log('\nOutput Merkle Proof:');
            console.log('  Index:', outputProof.outputIndex);
            console.log('  Proof:', JSON.stringify(outputProof.proof, null, 2));
        } catch (error) {
            console.error('Error:', error.message);
            process.exit(1);
        }
    })();
}
