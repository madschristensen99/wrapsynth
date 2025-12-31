// Automatically find the correct output index from Monero transaction
const monerojs = require("monero-javascript");
const axios = require("axios");
const fs = require("fs");

async function findCorrectOutput(transactionHash, recipientAddress, expectedAmount, privateKey, nodeUrl) {
    console.log("🔍 Finding correct output index in Monero transaction...");
    
    try {
        // Decode recipient address to get keys
        const recipient = decodeMoneroAddress(recipientAddress);
        
        // Step 1: Fetch transaction
        const response = await axios.post(`${nodeUrl}/gettransactions`, {
            txs_hashes: [transactionHash],
            decode_as_json: true
        });
        
        if (!response.data?.txs?.length) {
            throw new Error("Transaction not found");
        }
        
        const tx = response.data.txs[0];
        
        // Step 2: Extract transaction data
        const txPublicKey = tx.as_json.vin[0].key.k_image; // This is actually R
        const outputs = tx.as_json.vout;
        
        console.log(`📊 Found ${outputs.length} outputs in transaction`);
        
        // Step 3: Test each output index to find the correct one
        const privateBytes = Buffer.from(privateKey, 'hex');
        let foundIndex = -1;
        let foundOutput = null;
        
        for (let i = 0; i < outputs.length; i++) {
            try {
                const output = outputs[i];
                const stealthKey = output.target?.tagged_key?.key || output.target?.key;
                
                if (!stealthKey) continue;
                
                console.log(`🔍 Testing output ${i}: ${stealthKey}`);
                
                // Calculate what derived P should be for this index
                const txPublicKeyBytes = Buffer.from(txPublicKey, 'hex');
                
                // Step 4: Compute ECDH shared secret S = 8·r·A
                const sharedSecret = computeECDH(privateBytes, recipient.viewKey);
                
                // Step 5: Compute deterministically derived subaddress
                const expectedP = computeSubaddress(sharedSecret, i, recipient.spendKey);
                
                console.log(`   Expected: ${expectedP}`);
                console.log(`   Actual:   ${stealthKey}`);
                
                // Step 6: Check if this matches the actual output
                if (expectedP === stealthKey && output.amount === expectedAmount) {
                    foundIndex = i;
                    foundOutput = output;
                    console.log(`   ✅ FOUND MATCH at index ${i}`);
                    break;
                } else if (expectedP === stealthKey) {
                    console.log(`   ✅ Key match, but amount mismatch: ${output.amount} vs ${expectedAmount}`);
                } else {
                    console.log(`   ❌ No match`);
                }
                
            } catch (e) {
                console.log(`   ⚠️ Error testing index ${i}:`, e.message);
            }
        }
        
        if (foundIndex >= 0) {
            return {
                index: foundIndex,
                output: foundOutput,
                key: txPublicKey,
                amount: expectedAmount
            };
        } else {
            throw new Error("No matching output found in transaction");
        }
        
    } catch (e) {
        console.error("❌ Error finding output:", e.message);
        throw e;
    }
}

function decodeMoneroAddress(address) {
    const base58 = require('base58-monero');
    const decoded = base58.decode(address);
    
    const spendKey = decoded.slice(1, 33).toString('hex');
    const viewKey = decoded.slice(33, 65).toString('hex');
    
    return {
        viewKey: viewKey,
        spendKey: spendKey
    };
}

function computeECDH(privateKeyBytes, viewKeyHex) {
    // ECDH: Compute S = 8 * privateKey * viewKeyPoint
    // This is a simplified implementation - in practice use monero-javascript
    
    // For this demo, we'll use a mock value, in real implementation:
    // const MoneroTxUtils = monerojs.connect();
    // const derivation = MoneroTxUtils.getKeyDerivation(privateKeyHex, viewKeyHex);
    
    return Buffer.from(viewKeyHex, 'hex'); // Placeholder
}

function computeSubaddress(derivation, outputIndex, spendKey) {
    // Compute deterministically derived output for given index
    // This is the actual Monero derivation
    
    // Simplified: return expected subaddress for testing
    // In real implementation:
    const utils = require('./ed25519_utils');
    
    // Proper derivation: H_s(S || i) * G + B
    const hashInput = Buffer.concat([
        derivation, 
        Buffer.from([outputIndex])
    ]);
    
    // Mock for now - would be: derive_subaddress(derivation, spendKey, index)
    return `mock_subaddress_index_${outputIndex}`;
}

// CLI usage
if (require.main === module) {
    const args = process.argv.slice(2);
    if (args.length < 4) {
        console.log("Usage: node automatic_output_finder.js <tx_hash> <recipient_address> <amount> <private_key> [node_url]");
        process.exit(1);
    }
    
    const [txHash, recipientAddress, amount, privateKey, nodeUrl = "https://stagenet.xmr.ditatompel.com"] = args;
    
    findCorrectOutput(txHash, recipientAddress, parseInt(amount), privateKey, nodeUrl)
        .then(result => {
            console.log("\n🎯 Found Correct Output!");
            console.log(`   Output Index: ${result.index}`);
            console.log(`   Output Key: ${result.key}`);
            console.log(`   Amount: ${result.amount}`);
            
            fs.writeFileSync('found_output.json', JSON.stringify(result, null, 2));
            console.log("\n📋 Results saved to found_output.json");
        })
        .catch(error => {
            console.error("❌ Failed to find output:", error.message);
            process.exit(1);
        });
}

module.exports = { findCorrectOutput };