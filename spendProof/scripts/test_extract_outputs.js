/**
 * Test output extraction from block 2028323
 */

const axios = require('axios');

const MONERO_RPC = 'https://stagenet.xmr.ditatompel.com';
const BLOCK_HEIGHT = 2028323;

async function testExtract() {
    console.log(`\n🔍 Testing output extraction from block ${BLOCK_HEIGHT}...\n`);
    
    try {
        // Get block
        const blockResponse = await axios.post(MONERO_RPC + '/json_rpc', {
            jsonrpc: '2.0',
            id: '0',
            method: 'get_block',
            params: { height: BLOCK_HEIGHT }
        });
        
        const blockData = blockResponse.data.result;
        const blockJson = JSON.parse(blockData.json);
        const txHashes = blockJson.tx_hashes || [];
        
        console.log(`Block ${BLOCK_HEIGHT}:`);
        console.log(`   Transactions: ${txHashes.length}`);
        console.log(`   TX Hash: ${txHashes[0]}\n`);
        
        // Get transaction
        const txResponse = await axios.post(MONERO_RPC + '/get_transactions', {
            txs_hashes: txHashes,
            decode_as_json: true
        });
        
        const tx = txResponse.data.txs[0];
        const txJson = JSON.parse(tx.as_json);
        
        console.log(`Transaction Details:`);
        console.log(`   Outputs: ${txJson.vout.length}\n`);
        
        // Extract outputs
        const allOutputs = [];
        for (let i = 0; i < txJson.vout.length; i++) {
            const output = txJson.vout[i];
            const ecdh = txJson.rct_signatures.ecdhInfo[i];
            const commitment = txJson.rct_signatures.outPk[i];
            
            // Handle both formats
            let outputPubKey = null;
            if (output.target) {
                if (output.target.key) {
                    outputPubKey = output.target.key;
                } else if (output.target.tagged_key && output.target.tagged_key.key) {
                    outputPubKey = output.target.tagged_key.key;
                }
            }
            
            console.log(`Output ${i}:`);
            console.log(`   Output Pub Key: ${outputPubKey}`);
            console.log(`   ECDH Amount: ${ecdh.amount}`);
            console.log(`   Commitment: ${commitment}\n`);
            
            if (ecdh && commitment && outputPubKey) {
                allOutputs.push({
                    txHash: '0x' + tx.tx_hash,
                    outputIndex: i,
                    ecdhAmount: '0x' + ecdh.amount,
                    outputPubKey: '0x' + outputPubKey,
                    commitment: '0x' + commitment
                });
            }
        }
        
        console.log(`✅ Extracted ${allOutputs.length} outputs!\n`);
        console.log('Output data:');
        console.log(JSON.stringify(allOutputs, null, 2));
        
    } catch (error) {
        console.error('❌ Error:', error.message);
    }
}

testExtract();
