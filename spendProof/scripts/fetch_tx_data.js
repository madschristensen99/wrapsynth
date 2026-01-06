/**
 * Fetch Transaction Data from Monero
 */

const axios = require('axios');

const MONERO_RPC = 'https://stagenet.xmr.ditatompel.com';
const TX_HASH = '5ed56dfa2bab6006f8cbed1f96fdea04e2c38487229d159e079c575f2534174f';

async function fetchTxData() {
    console.log('\n🔍 Fetching transaction data from Monero...\n');
    console.log(`TX Hash: ${TX_HASH}`);
    console.log(`RPC: ${MONERO_RPC}\n`);
    
    try {
        // Get transaction (non-JSON-RPC endpoint)
        const response = await axios.post(MONERO_RPC + '/get_transactions', {
            txs_hashes: [TX_HASH],
            decode_as_json: true
        });
        
        console.log('Response:', JSON.stringify(response.data, null, 2));
        
        if (response.data.status !== 'OK') {
            throw new Error(response.data.status || 'Unknown error');
        }
        
        const txs = response.data.txs;
        if (!txs || txs.length === 0) {
            throw new Error('Transaction not found');
        }
        
        const tx = txs[0];
        const txJson = JSON.parse(tx.as_json);
        
        console.log('✅ Transaction found!\n');
        console.log('📊 Transaction Details:');
        console.log(`   Version: ${txJson.version}`);
        console.log(`   Unlock Time: ${txJson.unlock_time}`);
        console.log(`   Outputs: ${txJson.vout.length}\n`);
        
        // Display all outputs
        console.log('🎯 Outputs:');
        txJson.vout.forEach((output, index) => {
            console.log(`\n   Output ${index}:`);
            console.log(`      Amount: ${output.amount || 'RingCT (hidden)'}`);
            console.log(`      Target Key: ${output.target.key}`);
            
            if (txJson.rct_signatures && txJson.rct_signatures.ecdhInfo && txJson.rct_signatures.ecdhInfo[index]) {
                const ecdh = txJson.rct_signatures.ecdhInfo[index];
                console.log(`      ECDH Amount: ${ecdh.amount}`);
                console.log(`      ECDH Mask: ${ecdh.mask || 'N/A'}`);
            }
            
            if (txJson.rct_signatures && txJson.rct_signatures.outPk && txJson.rct_signatures.outPk[index]) {
                console.log(`      Commitment: ${txJson.rct_signatures.outPk[index]}`);
            }
        });
        
        console.log('\n\n📝 Summary for Proof Generation:');
        console.log('════════════════════════════════════════════════════════\n');
        
        // You need to identify which output is yours
        console.log('⚠️  You need to identify which output is yours!');
        console.log('   Use your view key to check each output.\n');
        
        console.log('Full TX JSON saved for reference.');
        
        // Save to file
        const fs = require('fs');
        const path = require('path');
        const outputPath = path.join(__dirname, '../oracle/tx_data.json');
        fs.writeFileSync(outputPath, JSON.stringify({
            txHash: TX_HASH,
            txJson: txJson,
            rawTx: tx
        }, null, 2));
        console.log(`💾 Saved to: ${outputPath}\n`);
        
    } catch (error) {
        console.error('❌ Error:', error.message);
        if (error.response) {
            console.error('Response:', error.response.data);
        }
    }
}

fetchTxData();
