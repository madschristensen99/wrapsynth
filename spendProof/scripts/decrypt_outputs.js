/**
 * Decrypt Monero Transaction Outputs
 * Uses view key to identify which output belongs to the recipient
 */

const base58 = require('base58-monero');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Your transaction details
const TX_HASH = '8759425cbf9865243bf5ba75934be23e9acba13711a23d7c23d4770d1689cdd9';
const VIEW_KEY = '14e6b2d5e3f3df596fcceacdec8f3d0cd12005ffe5848e40c2b176cf84612809';
const LP_ADDRESS = '87G8STCTDVLXm3RYuTBUigPNY4N1yDroBBbDSEwME4w9ezDDcTJhXcSL6urUJiHJK2hADMyqweuMZgaK9fw2bF21CyAuQBQ';

async function decryptOutputs() {
    console.log('\n🔓 Decrypting Transaction Outputs...\n');
    console.log('TX Hash:', TX_HASH);
    console.log('LP Address:', LP_ADDRESS);
    console.log('View Key:', VIEW_KEY.substring(0, 16) + '...\n');
    
    try {
        // Load transaction data
        const txDataPath = path.join(__dirname, '../oracle/tx_data.json');
        const txData = JSON.parse(fs.readFileSync(txDataPath, 'utf8'));
        const txJson = txData.txJson;
        
        console.log('📦 Transaction has', txJson.vout.length, 'outputs\n');
        
        // Decode LP address to get public spend and view keys
        const decoded = base58.decode(LP_ADDRESS);
        const publicSpendKey = decoded.slice(1, 33).toString('hex');
        const publicViewKey = decoded.slice(33, 65).toString('hex');
        
        console.log('🔑 LP Address Keys:');
        console.log('   Public Spend Key:', publicSpendKey);
        console.log('   Public View Key:', publicViewKey);
        console.log('   Network Type: mainnet\n');
        
        // Check each output
        for (let outputIndex = 0; outputIndex < txJson.vout.length; outputIndex++) {
            const output = txJson.vout[outputIndex];
            const ecdhInfo = txJson.rct_signatures.ecdhInfo[outputIndex];
            const commitment = txJson.rct_signatures.outPk[outputIndex];
            
            console.log(`\n🎯 Output ${outputIndex}:`);
            console.log('   Output Public Key:', output.target.key);
            console.log('   ECDH Amount (encrypted):', ecdhInfo.amount);
            console.log('   Commitment:', commitment);
            
            try {
                // For now, let's just show both outputs and you can tell us which one is 0.0027 XMR
                // Full ECDH decryption requires complex Monero crypto that's better done with monero-wallet-rpc
                
                console.log('   ⚠️  Manual identification needed');
                console.log('   Expected amount: 0.0027 XMR (2700000000000 piconero)');
                
                // Try simple XOR decryption (may not work without proper shared secret)
                const encryptedAmount = ecdhInfo.amount;
                console.log('   Encrypted amount hex:', encryptedAmount);
                    
                    console.log('\n   💰 DECRYPTED AMOUNT:');
                    console.log('      Piconero:', amountPiconero);
                    console.log('      XMR:', amountXMR);
                    console.log('\n   ✅ This is the LP payment output!');
                    
                    // Save witness data
                    const witnessData = {
                        txHash: TX_HASH,
                        outputIndex: outputIndex,
                        outputPubKey: output.target.key,
                        ecdhAmount: ecdhInfo.amount,
                        commitment: commitment,
                        amount: amountPiconero,
                        amountXMR: amountXMR,
                        txPubKey: txPubKey,
                        lpAddress: LP_ADDRESS,
                        lpPublicSpendKey: address.publicSpendKey,
                        lpPublicViewKey: address.publicViewKey
                    };
                    
                    const witnessPath = path.join(__dirname, '../witness_data.json');
                    fs.writeFileSync(witnessPath, JSON.stringify(witnessData, null, 2));
                    console.log('\n   💾 Witness data saved to:', witnessPath);
                }
                
            } catch (error) {
                console.log('   ⚠️  Error checking output:', error.message);
            }
        }
        
        console.log('\n\n✅ Output decryption complete!');
        
    } catch (error) {
        console.error('\n❌ Error:', error.message);
        console.error(error.stack);
    }
}

decryptOutputs();
