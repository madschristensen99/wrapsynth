// Comprehensive test for amount fraud protection
// Tests that the circuit rejects various wrong amount claims

const fs = require('fs');
const { execSync } = require('child_process');

console.log("🔒 Testing Amount Fraud Protection\n");
console.log("This test verifies that users cannot claim arbitrary amounts\n");

// Load the real input
const realInput = JSON.parse(fs.readFileSync('input.json', 'utf8'));
const realAmount = BigInt(realInput.v);

console.log(`Real amount: ${realAmount} piconero (${Number(realAmount) / 1e12} XMR)\n`);

// Test cases: various fraudulent amount claims
const fraudCases = [
    { multiplier: 2, description: "2x the real amount" },
    { multiplier: 5, description: "5x the real amount" },
    { multiplier: 10, description: "10x the real amount" },
    { multiplier: 100, description: "100x the real amount" },
    { multiplier: 0.5, description: "Half the real amount" },
    { multiplier: 0.1, description: "10% of real amount" },
    { add: 1000000000n, description: "+0.001 XMR" },
    { add: -1000000000n, description: "-0.001 XMR" },
];

let passCount = 0;
let failCount = 0;

for (let i = 0; i < fraudCases.length; i++) {
    const testCase = fraudCases[i];
    let fraudAmount;
    
    if (testCase.multiplier) {
        fraudAmount = BigInt(Math.floor(Number(realAmount) * testCase.multiplier));
    } else if (testCase.add) {
        fraudAmount = realAmount + testCase.add;
    }
    
    console.log(`Test ${i + 1}: Claim ${testCase.description}`);
    console.log(`  Claimed: ${fraudAmount} piconero (${Number(fraudAmount) / 1e12} XMR)`);
    
    const fraudInput = JSON.parse(JSON.stringify(realInput));
    fraudInput.v = fraudAmount.toString();
    
    const filename = `input_fraud_${i}.json`;
    const witnessFile = `witness_fraud_${i}.wtns`;
    
    fs.writeFileSync(filename, JSON.stringify(fraudInput, null, 2));
    
    try {
        execSync(`snarkjs wtns calculate build/monero_bridge_js/monero_bridge.wasm ${filename} ${witnessFile}`, {
            cwd: __dirname + '/..',
            stdio: 'pipe'
        });
        console.log(`  ❌ FAIL - Fraud accepted! (SECURITY VULNERABILITY)\n`);
        failCount++;
    } catch (e) {
        console.log(`  ✅ PASS - Fraud rejected by circuit\n`);
        passCount++;
    }
    
    // Clean up
    try {
        fs.unlinkSync(filename);
        fs.unlinkSync(witnessFile);
    } catch (e) {
        // Ignore cleanup errors
    }
}

console.log("═══════════════════════════════════════");
console.log(`Results: ${passCount}/${fraudCases.length} fraud attempts blocked`);

if (failCount === 0) {
    console.log("✅ SUCCESS - All fraud attempts were rejected!");
    console.log("   Amount verification is working correctly.");
} else {
    console.log(`❌ FAILURE - ${failCount} fraud attempts were accepted!`);
    console.log("   🚨 CRITICAL SECURITY VULNERABILITY!");
}
console.log("═══════════════════════════════════════");
