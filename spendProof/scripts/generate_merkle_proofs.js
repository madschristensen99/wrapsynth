const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const { keccak256 } = require('js-sha3');

const MONERO_RPC = 'http://xmr.privex.io:18081';
const BLOCK_HEIGHT = 3595150;
const TX_HASH = '73155c18b4b6a820ace7a77973ae1004bb8b1b8c0c8a96c9c7a6957309f14d79';

function sha256(data) {
    return crypto.createHash('sha256').update(data).digest();
}

function keccak256Hash(data) {
    return Buffer.from(keccak256(data), 'hex');
}

function buildMerkleTree(leaves, useKeccak = false) {
    if (leaves.length === 0) return { root: Buffer.alloc(32), proofs: [] };
    if (leaves.length === 1) return { root: leaves[0], proofs: [[]] };
    
    let level = leaves.map(l => Buffer.from(l.replace(/^0x/, ''), 'hex'));
    const proofs = leaves.map(() => []);
    let indices = leaves.map((_, i) => i);
    
    while (level.length > 1) {
        const nextLevel = [];
        const nextIndices = [];
        
        for (let i = 0; i < level.length; i += 2) {
            const left = level[i];
            const right = i + 1 < level.length ? level[i + 1] : left;
            
            // Record siblings for all original leaves at these positions
            const leftOriginalIndices = indices[i];
            const rightOriginalIndices = i + 1 < level.length ? indices[i + 1] : indices[i];
            
            // For left node, sibling is right
            if (Array.isArray(leftOriginalIndices)) {
                leftOriginalIndices.forEach(idx => {
                    proofs[idx].push('0x' + right.toString('hex'));
                });
            } else {
                proofs[leftOriginalIndices].push('0x' + right.toString('hex'));
            }
            
            // For right node (if exists), sibling is left
            if (i + 1 < level.length) {
                if (Array.isArray(rightOriginalIndices)) {
                    rightOriginalIndices.forEach(idx => {
                        proofs[idx].push('0x' + left.toString('hex'));
                    });
                } else {
                    proofs[rightOriginalIndices].push('0x' + left.toString('hex'));
                }
            }
            
            const combined = Buffer.concat([left, right]);
            const hash = useKeccak ? keccak256Hash(combined) : sha256(combined);
            nextLevel.push(hash);
            
            // Merge indices for next level
            const mergedIndices = Array.isArray(leftOriginalIndices) ? leftOriginalIndices : [leftOriginalIndices];
            if (i + 1 < level.length) {
                const rightIndices = Array.isArray(rightOriginalIndices) ? rightOriginalIndices : [rightOriginalIndices];
                mergedIndices.push(...rightIndices);
            }
            nextIndices.push(mergedIndices);
        }
        
        level = nextLevel;
        indices = nextIndices;
    }
    
    return {
        root: '0x' + level[0].toString('hex'),
        proofs: proofs
    };
}

async function main() {
    console.log('🌳 Generating Merkle Proofs\n');
    console.log('Block:', BLOCK_HEIGHT);
    console.log('TX Hash:', TX_HASH);
    console.log();
    
    // Fetch block data
    console.log('📡 Fetching block data...');
    const blockResponse = await axios.post(MONERO_RPC + '/json_rpc', {
        jsonrpc: '2.0',
        id: '0',
        method: 'get_block',
        params: { height: BLOCK_HEIGHT }
    });
    
    const block = blockResponse.data.result;
    const blockHeader = typeof block.block_header === 'string' ? JSON.parse(block.block_header) : block.block_header;
    
    console.log('✅ Block fetched');
    console.log('   TX count:', block.tx_hashes ? block.tx_hashes.length + 1 : 1); // +1 for coinbase
    console.log();
    
    // Get all transaction hashes (regular txs only, no miner TX to match oracle)
    const txHashes = block.tx_hashes || [];
    
    console.log('📝 Transaction hashes:');
    txHashes.forEach((hash, i) => {
        const marker = hash === TX_HASH ? ' ← OUR TX' : '';
        console.log(`   ${i}: ${hash}${marker}`);
    });
    console.log();
    
    // Find our transaction index
    const txIndex = txHashes.findIndex(h => h === TX_HASH);
    if (txIndex === -1) {
        throw new Error('Transaction not found in block!');
    }
    
    console.log('✅ Found our transaction at index:', txIndex);
    console.log();
    
    // Build TX Merkle tree (using Keccak256 to match contract)
    console.log('🌳 Building TX Merkle tree (Keccak256)...');
    const txTree = buildMerkleTree(txHashes, true);
    console.log('   Root:', txTree.root);
    console.log('   Proof length:', txTree.proofs[txIndex].length);
    console.log();
    
    // Fetch ALL transactions in block to build output Merkle tree
    console.log('📡 Fetching ALL transactions in block...');
    const allTxResponse = await axios.post(MONERO_RPC + '/gettransactions', {
        txs_hashes: txHashes,
        decode_as_json: true
    });
    
    console.log('✅ Transactions fetched:', allTxResponse.data.txs.length);
    console.log();
    
    // Build output leaves from ALL transactions
    const outputLeaves = [];
    let ourOutputGlobalIndex = -1;
    let globalOutputIndex = 0;
    
    for (const tx of allTxResponse.data.txs) {
        const txJson = JSON.parse(tx.as_json);
        const txHashForOutput = tx.tx_hash;
        
        for (let i = 0; i < txJson.vout.length; i++) {
            const output = txJson.vout[i];
            const ecdhInfo = txJson.rct_signatures.ecdhInfo[i];
            const commitment = txJson.rct_signatures.outPk[i];
        
            // Get output public key (handle different formats)
            const outputPubKey = output.target?.key || output.target?.tagged_key?.key || '';
            if (!outputPubKey) {
                console.error('Warning: Output', i, 'has no public key');
                globalOutputIndex++;
                continue;
            }
        
            // Match oracle's output leaf format (Keccak256 of ABI-encoded data)
            const ethers = require('ethers');
            const ecdhAmountPadded = '0x' + ecdhInfo.amount.padEnd(64, '0');
            const leaf = ethers.keccak256(
                ethers.AbiCoder.defaultAbiCoder().encode(
                    ['bytes32', 'uint256', 'bytes32', 'bytes32', 'bytes32'],
                    [
                        '0x' + txHashForOutput,
                        i,
                        ecdhAmountPadded,
                        '0x' + outputPubKey,
                        '0x' + commitment
                    ]
                )
            );
            
            outputLeaves.push(leaf);
            
            // Track our output
            if (txHashForOutput === TX_HASH && i === 0) {
                ourOutputGlobalIndex = globalOutputIndex;
                console.log(`📦 Output ${globalOutputIndex} (our output):`);
                console.log('   TX:', txHashForOutput);
                console.log('   Output Index:', i);
                console.log('   ECDH Amount:', ecdhInfo.amount);
                console.log('   Output PubKey:', outputPubKey);
                console.log('   Commitment:', commitment);
                console.log('   Leaf:', leaf);
                console.log();
            }
            
            globalOutputIndex++;
        }
    }
    
    // Build output Merkle tree (using SHA256 to match contract)
    console.log('🌳 Building Output Merkle tree (SHA256)...');
    console.log('   Total outputs:', outputLeaves.length);
    console.log('   Our output global index:', ourOutputGlobalIndex);
    const outputTree = buildMerkleTree(outputLeaves, false);
    console.log('   Root:', outputTree.root);
    console.log('   Proof length:', outputTree.proofs[ourOutputGlobalIndex].length);
    console.log();
    
    // Save proofs
    const proofData = {
        blockHeight: BLOCK_HEIGHT,
        txHash: TX_HASH,
        txIndex: txIndex,
        txMerkleProof: txTree.proofs[txIndex],
        txMerkleRoot: txTree.root,
        outputIndex: ourOutputGlobalIndex,
        outputMerkleProof: outputTree.proofs[ourOutputGlobalIndex],
        outputMerkleRoot: outputTree.root
    };
    
    fs.writeFileSync('merkle_proofs.json', JSON.stringify(proofData, null, 2));
    console.log('💾 Merkle proofs saved to merkle_proofs.json');
    console.log();
    
    console.log('✅ Merkle proof generation complete!');
    console.log('\nProof data:');
    console.log('   TX Index:', txIndex);
    console.log('   TX Proof siblings:', txTree.proofs[txIndex].length);
    console.log('   Output Proof siblings:', outputTree.proofs[0].length);
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error('\n❌ Error:', error.message);
        console.error(error.stack);
        process.exit(1);
    });
