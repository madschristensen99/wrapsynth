const { execSync } = require('child_process');
const fs = require('fs');

const transactions = [
    {
        name: "TX1",
        hash: "5caae835b751a5ab243b455ad05c489cb9a06d8444ab2e8d3a9d8ef905c1439a",
        block: 1934116,
        secretKey: "4cbf8f2cfb622ee126f08df053e99b96aa2e8c1cfd575d2a651f3343b465800a",
        amount: 20000000000,
        destination: "53Kajgo3GhV1ddabJZqdmESkXXoz2xD2gUCVc5L2YKjq8Qhx6UXoqFChhF9n2Th9NLTz77258PMdc3G5qxVd487pFZzzVNG",
        output_index: 0  // Confirmed by block explorer: output 0 matches with 0.02 XMR
    },
    {
        name: "TX2",
        hash: "efab02571fe41662cd1d10b551e9cd822bf2a32b4b5d23f653862a98b0af2682",
        block: 1948001,
        secretKey: "c7637fdfa0ae785a8982473b49a6c1ebf082e6737b837f4e1c40a270acf8130e",
        amount: 0.010000000000,
        destination: "74Di3cYaTj7DG5D7ucHEeiSZzrH9kyrFX8ujg2S3ydoZQEkKhpFjGkGLcpenYEHMW1aYNQcy6n75MbDfFwch4657E8WjVhE"
    },
    {
        name: "TX3",
        hash: "827368baa751b395728f79608c0792419a88f08119601669baede39ba0225d4b",
        block: 2023616,
        secretKey: "ab923eb60a5de7ff9e40be288ae55ccaea5a6ee175180eabe7774a2951d59701",
        amount: 0.001150000000,
        destination: "77tyMuyZhpUNuqKfNTHL3J9AxDVX6MKRvgjLEMPra23CMUGX1UZEHJYLtG54ziVsUqdDLbtLrpMCnbPgvqAAzJrRM3jevta",
        output_index: 0
    }
];

console.log('🧪 Testing all three transactions\n');

for (const tx of transactions) {
    console.log(`Testing ${tx.name}...`);
    
    // Convert amount to piconero if it's a decimal (< 1000 means it's in XMR)
    const amountPiconero = tx.amount < 1000 ? Math.round(tx.amount * 1e12) : tx.amount;
    
    // Update generate_witness.js with this transaction's data
    const witnessScript = fs.readFileSync('scripts/generate_witness.js', 'utf8');
    // Match TX_DATA object (multi-line)
    const updated = witnessScript.replace(
        /const TX_DATA = \{[\s\S]*?\};/,
        `const TX_DATA = {
    hash: "${tx.hash}",
    block: ${tx.block},
    secretKey: "${tx.secretKey}",
    amount: ${amountPiconero},
    destination: "${tx.destination}",
    output_index: ${tx.output_index || 0},
    node: "https://stagenet.xmr.ditatompel.com"
};`
    );
    fs.writeFileSync('scripts/generate_witness.js', updated);
    
    // Generate witness with timing
    const witnessStart = Date.now();
    try {
        execSync('node scripts/generate_witness.js > /dev/null 2>&1');
        const witnessTime = Date.now() - witnessStart;
        console.log(`  ⏱️  Witness generation: ${witnessTime}ms`);
    } catch(e) {
        console.log(`  ❌ Witness generation failed`);
        continue;
    }
    
    // Test witness with timing
    const calcStart = Date.now();
    try {
        execSync('snarkjs wtns calculate build/monero_bridge_js/monero_bridge.wasm input.json witness.wtns 2>&1', {stdio: 'pipe'});
        const calcTime = Date.now() - calcStart;
        console.log(`  ⏱️  Circuit calculation: ${calcTime}ms`);
        console.log(`  ✅ PASS - ${tx.name} accepted by circuit\n`);
    } catch(e) {
        console.log(`  ❌ FAIL - ${tx.name} rejected by circuit\n`);
    }
}

console.log('Done!');
