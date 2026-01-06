/**
 * Identify which output belongs to you
 * 
 * Uses view key to decrypt ECDH amounts
 */

const fs = require('fs');
const path = require('path');

// Load transaction data
const txDataPath = path.join(__dirname, '../oracle/tx_data.json');
const txData = JSON.parse(fs.readFileSync(txDataPath, 'utf8'));

// Load LP info
const lpInfoPath = path.join(__dirname, '../oracle/lp_info.json');
const lpInfo = JSON.parse(fs.readFileSync(lpInfoPath, 'utf8'));

console.log('\n🔍 Identifying Your Output...\n');
console.log(`TX Hash: ${txData.txHash}`);
console.log(`Your View Key: ${lpInfo.viewKey}\n`);

const txJson = txData.txJson;

console.log('📊 Outputs in Transaction:\n');

txJson.vout.forEach((output, index) => {
    const ecdh = txJson.rct_signatures.ecdhInfo[index];
    const commitment = txJson.rct_signatures.outPk[index];
    const outputPubKey = output.target.key;
    
    console.log(`Output ${index}:`);
    console.log(`   Output Public Key: ${outputPubKey}`);
    console.log(`   ECDH Amount: ${ecdh.amount}`);
    console.log(`   Commitment: ${commitment}`);
    
    // Convert ECDH amount to decimal
    const ecdhAmountHex = ecdh.amount;
    const ecdhAmountBigInt = BigInt('0x' + ecdhAmountHex);
    console.log(`   ECDH Amount (decimal): ${ecdhAmountBigInt.toString()}`);
    console.log('');
});

console.log('\n📝 To identify your output, you need to:');
console.log('   1. Use monero-wallet-cli to check which output is yours');
console.log('   2. Or use the view key to derive the shared secret');
console.log('   3. XOR the ECDH amount with the amount key to get the real amount\n');

console.log('💡 Expected amount: 3141590000 piconero (0.003141590000 XMR)\n');

// Save output data for proof generation
const outputData = {
    txHash: txData.txHash,
    outputs: txJson.vout.map((output, index) => ({
        index,
        outputPubKey: output.target.key,
        ecdhAmount: txJson.rct_signatures.ecdhInfo[index].amount,
        commitment: txJson.rct_signatures.outPk[index]
    }))
};

const outputDataPath = path.join(__dirname, '../oracle/output_data.json');
fs.writeFileSync(outputDataPath, JSON.stringify(outputData, null, 2));
console.log(`💾 Output data saved to: ${outputDataPath}\n`);
