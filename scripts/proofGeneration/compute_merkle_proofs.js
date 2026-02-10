const { MerkleTree } = require('merkletreejs');
const { keccak256 } = require('js-sha3');
const crypto = require('crypto');
const axios = require('axios');

const sha256 = (data) => crypto.createHash('sha256').update(data).digest();

async function computeMerkleProofs(blockHeight, txHash, outputIndex) {
    console.log('\n🌳 Computing Merkle Proofs\n');
    console.log('═'.repeat(70));
    
    // Fetch block data from Monero
    const rpcUrl = 'http://xmr.privex.io:18081';
    
    // Get block by height
    const blockResp = await axios.post(rpcUrl + '/json_rpc', {
        jsonrpc: '2.0',
        id: '0',
        method: 'get_block',
        params: { height: blockHeight }
    });
    
    const blockData = JSON.parse(blockResp.data.result.json);
    console.log(`\n📦 Block ${blockHeight}:`);
    console.log(`   Miner TX: ${blockData.miner_tx_hash}`);
    console.log(`   Transactions: ${blockData.tx_hashes.length + 1}`); // +1 for coinbase
    
    // Build TX Merkle tree using SHA256 (contract uses SHA256)
    const txHashes = [blockData.miner_tx_hash, ...blockData.tx_hashes].filter(h => h);
    console.log(`   First few TXs: ${txHashes.slice(0, 3).map(h => h.slice(0,16)).join(', ')}...`);
    const txLeaves = txHashes.map(h => Buffer.from(h, 'hex'));
    const txTree = new MerkleTree(txLeaves, sha256, { sortPairs: false });
    
    const txRoot = '0x' + txTree.getRoot().toString('hex');
    console.log(`\n🌳 TX Merkle Tree:`);
    console.log(`   Root: ${txRoot}`);
    
    // Find our transaction
    const txLeaf = Buffer.from(txHash, 'hex');
    const txIndex = txLeaves.findIndex(l => l.equals(txLeaf));
    
    if (txIndex === -1) {
        console.log(`\n❌ Transaction ${txHash} not found in block!`);
        return null;
    }
    
    const txProof = txTree.getProof(txLeaf).map(p => '0x' + p.data.toString('hex'));
    console.log(`   TX Index: ${txIndex}`);
    console.log(`   TX Proof length: ${txProof.length}`);
    
    // Get transaction details for output Merkle tree
    const txResp = await axios.post(rpcUrl + '/get_transactions', {
        txs_hashes: [txHash],
        decode_as_json: true
    });
    
    const txJson = JSON.parse(txResp.data.txs[0].as_json);
    console.log(`\n📤 Transaction Outputs: ${txJson.vout.length}`);
    
    // Build output Merkle tree
    // Leaf = keccak256(abi.encodePacked(txHash, outputIndex, ecdhAmount, outputPubKey, commitment))
    // Tree uses SHA256
    const outputLeaves = txJson.vout.map((out, idx) => {
        // Extract output data from RCT signatures
        const ecdhAmount = txJson.rct_signatures?.ecdhInfo?.[idx]?.amount || '0000000000000000';
        const outputKey = out.target.tagged_key?.key || out.target?.key || '00'.repeat(32);
        const commitment = txJson.rct_signatures?.outPk?.[idx] || '00'.repeat(64);
        
        console.log(`   Output ${idx}:`);
        console.log(`      key: ${outputKey}`);
        console.log(`      amount: ${ecdhAmount}`);
        console.log(`      commitment: ${commitment}`);
        
        // Compute leaf like contract: keccak256(abi.encodePacked(...))
        const packed = Buffer.concat([
            Buffer.from(txHash, 'hex'),
            Buffer.from([idx]),
            Buffer.from(ecdhAmount.padEnd(64, '0'), 'hex'), // 32 bytes
            Buffer.from(outputKey, 'hex'), // 32 bytes
            Buffer.from(commitment, 'hex') // 32 bytes
        ]);
        const leaf = Buffer.from(keccak256(packed), 'hex');
        console.log(`      leaf: 0x${leaf.toString('hex')}`);
        return leaf;
    });
    
    const outputTree = new MerkleTree(outputLeaves, sha256, { sortPairs: false });
    const outputRoot = '0x' + outputTree.getRoot().toString('hex');
    console.log(`\n🌳 Output Merkle Tree:`);
    console.log(`   Root: ${outputRoot}`);
    
    const outputLeaf = outputLeaves[outputIndex];
    const outputProof = outputTree.getProof(outputLeaf).map(p => '0x' + p.data.toString('hex'));
    console.log(`   Output Index: ${outputIndex}`);
    console.log(`   Output Proof length: ${outputProof.length}`);
    
    console.log('\n✅ Merkle proofs computed!');
    console.log('\nUse these in your mint call:');
    console.log(`   txMerkleProof: [${txProof.map(p => `"${p}"`).join(', ')}]`);
    console.log(`   txIndex: ${txIndex}`);
    console.log(`   outputMerkleProof: [${outputProof.map(p => `"${p}"`).join(', ')}]`);
    console.log(`   outputIndex: ${outputIndex}`);
    
    return {
        txMerkleProof: txProof,
        txIndex,
        outputMerkleProof: outputProof,
        outputIndex,
        txRoot,
        outputRoot
    };
}

// Run
const BLOCK_HEIGHT = 3602906;
const TX_HASH = '367f490e18f7ac0d8a86172290c4b9bf4620f1115c682ef1bfc5b9ec69d79272';
const OUTPUT_INDEX = 0;

computeMerkleProofs(BLOCK_HEIGHT, TX_HASH, OUTPUT_INDEX)
    .then(() => process.exit(0))
    .catch(error => {
        console.error('\n❌ Error:', error.message);
        process.exit(1);
    });
