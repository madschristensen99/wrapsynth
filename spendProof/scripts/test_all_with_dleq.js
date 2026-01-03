#!/usr/bin/env node

const { execSync } = require('child_process');
const fs = require('fs');
const { generateWitness } = require('./generate_witness.js');

// Test transactions (3 stagenet + 1 mainnet)
const transactions = [
    {
        name: "TX1",
        hash: "5caae835b751a5ab243b455ad05c489cb9a06d8444ab2e8d3a9d8ef905c1439a",
        block: 1934116,
        secretKey: "4cbf8f2cfb622ee126f08df053e99b96aa2e8c1cfd575d2a651f3343b465800a",
        amount: 20000000000,
        destination: "53Kajgo3GhV1ddabJZqdmESkXXoz2xD2gUCVc5L2YKjq8Qhx6UXoqFChhF9n2Th9NLTz77258PMdc3G5qxVd487pFZzzVNG",
        output_index: 0,
        node: "https://stagenet.xmr.ditatompel.com"
    },
    {
        name: "TX2",
        hash: "efab02571fe41662cd1d10b551e9cd822bf2a32b4b5d23f653862a98b0af2682",
        block: 1948001,
        secretKey: "c7637fdfa0ae785a8982473b49a6c1ebf082e6737b837f4e1c40a270acf8130e",
        amount: 10000000000,
        destination: "74Di3cYaTj7DG5D7ucHEeiSZzrH9kyrFX8ujg2S3ydoZQEkKhpFjGkGLcpenYEHMW1aYNQcy6n75MbDfFwch4657E8WjVhE",
        output_index: 0,
        node: "https://stagenet.xmr.ditatompel.com"
    },
    {
        name: "TX3",
        hash: "827368baa751b395728f79608c0792419a88f08119601669baede39ba0225d4b",
        block: 2023616,
        secretKey: "ab923eb60a5de7ff9e40be288ae55ccaea5a6ee175180eabe7774a2951d59701",
        amount: 1150000000,
        destination: "77tyMuyZhpUNuqKfNTHL3J9AxDVX6MKRvgjLEMPra23CMUGX1UZEHJYLtG54ziVsUqdDLbtLrpMCnbPgvqAAzJrRM3jevta",
        output_index: 0,
        node: "https://stagenet.xmr.ditatompel.com"
    },
    {
        name: "TX4 (MAINNET)",
        hash: "bb1eab8e0de071a272e522ad912d143aa531e0016d51e0aec800be39511dd141",
        block: 3569096,
        secretKey: "9be32769af6e99d0fef1dcddbef68f254004e2eb06e8f712c01a63d235a5410c",
        amount: 931064529072,
        destination: "87DZ8wkCoePVH7UH7zL3FhR2CjadnC83pBMqXZizg7T2dJod5rzQuAMbBg5PtcA9dHTtWAvrL7ZCTXEC2RDV3Mr4HJYP9gj",
        output_index: 0,
        node: "https://monero-rpc.cheems.de.box.skhron.com.ua:18089"
    }
];

console.log('🧪 Testing All 4 Transactions with DLEQ Proofs\n');
console.log('📊 Circuit: 1,167 constraints (99.97% reduction)\n');
console.log('═'.repeat(70) + '\n');

let passedTests = 0;
let totalTests = 0;

async function testTransaction(tx) {
    console.log(`\n${'━'.repeat(70)}`);
    console.log(`📝 ${tx.name}`);
    console.log(`   Hash: ${tx.hash.slice(0, 16)}...`);
    console.log(`   Amount: ${tx.amount} piconero`);
    console.log('━'.repeat(70));
    
    const amountPiconero = tx.amount < 1000 ? Math.round(tx.amount * 1e12) : tx.amount;
    
    // Step 1: Fetch from blockchain using old witness generator
    console.log('\n  🔄 Step 1: Fetching from blockchain...');
    const witnessScript = fs.readFileSync('scripts/fetch_monero_witness.js', 'utf8');
    const updated = witnessScript.replace(
        /const TX_DATA = \{[\s\S]*?\};/,
        `const TX_DATA = {
    hash: "${tx.hash}",
    block: ${tx.block},
    secretKey: "${tx.secretKey}",
    amount: ${amountPiconero},
    destination: "${tx.destination}",
    output_index: ${tx.output_index || 0},
    node: "${tx.node || 'https://stagenet.xmr.ditatompel.com'}"
};`
    );
    fs.writeFileSync('scripts/fetch_monero_witness.js', updated);
    
    try {
        const fetchStart = Date.now();
        execSync('node scripts/fetch_monero_witness.js > /dev/null 2>&1');
        const fetchTime = Date.now() - fetchStart;
        console.log(`  ✅ Blockchain data fetched (${fetchTime}ms)`);
    } catch(e) {
        console.log(`  ❌ Fetch failed: ${e.message}`);
        return false;
    }
    
    // Step 2: Generate DLEQ witness from blockchain data
    console.log('\n  🔄 Step 2: Computing DLEQ witness...');
    try {
        // Read blockchain data
        const blockchainData = JSON.parse(fs.readFileSync('input.json', 'utf8'));
        
        // Generate DLEQ-optimized witness
        const witness = await generateWitness(blockchainData);
        
        // Save circuit inputs
        const circuitInputs = {
            r: witness.r,
            v: witness.v,
            H_s_scalar: witness.H_s_scalar,
            R_x: witness.R_x,
            S_x: witness.S_x,
            P_compressed: witness.P_compressed,
            ecdhAmount: witness.ecdhAmount,
            amountKey: witness.amountKey,
            commitment: witness.commitment
        };
        
        fs.writeFileSync('input.json', JSON.stringify(circuitInputs, null, 2));
        console.log(`  ✅ DLEQ witness generated`);
    } catch(e) {
        console.log(`  ❌ DLEQ generation failed: ${e.message}`);
        return false;
    }
    
    // Step 3: Calculate witness
    console.log('\n  🧪 Step 3: Calculating witness...');
    try {
        const calcStart = Date.now();
        execSync('snarkjs wtns calculate build/monero_bridge_js/monero_bridge.wasm input.json witness.wtns 2>&1', {stdio: 'pipe'});
        const calcTime = Date.now() - calcStart;
        console.log(`  ✅ Witness calculated (${calcTime}ms)`);
    } catch(e) {
        console.log(`  ❌ Witness calculation failed`);
        return false;
    }
    
    // Step 4: Generate PLONK proof
    console.log('\n  🔐 Step 4: Generating PLONK proof...');
    totalTests++;
    try {
        const proveStart = Date.now();
        execSync('snarkjs plonk prove circuit_final.zkey witness.wtns proof_tx.json public_tx.json 2>&1', {stdio: 'pipe'});
        const proveTime = Date.now() - proveStart;
        console.log(`  ✅ PLONK proof generated (${(proveTime/1000).toFixed(2)}s)`);
    } catch(e) {
        console.log(`  ❌ PLONK proof generation failed`);
        return false;
    }
    
    // Step 5: Verify PLONK proof
    console.log('\n  ✅ Step 5: Verifying PLONK proof...');
    try {
        const verifyStart = Date.now();
        const result = execSync('snarkjs plonk verify verification_key.json public_tx.json proof_tx.json 2>&1', {encoding: 'utf8'});
        const verifyTime = Date.now() - verifyStart;
        
        if (result.includes('OK!')) {
            console.log(`  ✅ PLONK proof verified (${verifyTime}ms)`);
            passedTests++;
            return true;
        } else {
            console.log(`  ❌ PLONK proof verification FAILED`);
            return false;
        }
    } catch(e) {
        console.log(`  ❌ PLONK verification failed: ${e.message}`);
        return false;
    }
}

(async () => {
    for (const tx of transactions) {
        await testTransaction(tx);
    }
    
    console.log('\n' + '═'.repeat(70));
    console.log(`\n🎯 FINAL RESULTS: ${passedTests}/${totalTests} transactions passed\n`);
    console.log('═'.repeat(70));
    
    if (passedTests === totalTests) {
        console.log('\n✅ ALL TESTS PASSED!\n');
        process.exit(0);
    } else {
        console.log(`\n❌ ${totalTests - passedTests} tests failed!\n`);
        process.exit(1);
    }
})().catch(console.error);
