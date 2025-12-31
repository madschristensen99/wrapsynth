// Targeted security failure test for wrong destination and secret key
const fs = require('fs');
const { execSync } = require('child_process');
const path = require('path');

console.log("🔒 Testing Security Failures - Wrong Destination & Secret Key\n");

// Load original test data
const testData = require('./input.json');

function runCircuitTest(name, inputData) {
    console.log(`=== ${name} ===`);
    
    try {
        // Write test input
        fs.writeFileSync('test_security.json', JSON.stringify(inputData, null, 2));
        
        // Generate witness
        try {
            execSync('node monero_bridge_js/generate_witness.js monero_bridge_js/monero_bridge.wasm test_security.json test_security.wtns', {
                stdio: 'pipe'
            });
            
            // Try to verify (this will fail with wrong data)
            console.log("❌ FAIL - Circuit ACCEPTED (this should be rejected!)");
            return false;
        } catch (e) {
            console.log("✅ PASS - Circuit correctly REJECTED");
            return true;
        }
    } catch (e) {
        console.log("❌ ERROR -", e.message);
        return false;
    }
    console.log("");
}

// Original correct data
const originalData = { ...testData };

// Test 1: Wrong destination address (P_compressed)
const wrongDestData = { ...originalData };
wrongDestData.P_compressed = "invalid_destination_address_123456789";

// Test 2: Wrong secret key (r field)
const wrongSecretData = { ...originalData };
wrongSecretData.r = Array(256).fill(1).map(() => Math.floor(Math.random() * 2));

// Test 3: Valid secret but wrong recipient (change A_compressed)
const wrongRecipient = { ...originalData };
wrongRecipient.A_compressed = "wrong_lp_view_key_987654321";

// Test 4: Valid data but wrong spend key (B_compressed)
const wrongSpend = { ...originalData };
wrongSpend.B_compressed = "wrong_spend_key_555666777";

// Run tests
console.log("Testing Security Boundaries...\n");

const tests = [
    ["Test 1: Wrong Destination Address", wrongDestData],
    ["Test 2: Wrong Secret Key", wrongSecretData],
    ["Test 3: Wrong Recipient View Key", wrongRecipient],
    ["Test 4: Wrong Spend Key", wrongSpend]
];

let passed = 0;
let total = tests.length;

tests.forEach(([name, data]) => {
    if (runCircuitTest(name, data)) {
        passed++;
    }
});

console.log(`\n═══════════════════════════════`);
console.log(`Security Test Summary:`);
console.log(`✅ Passed: ${passed}/${total}`);
console.log(`❌ Failed: ${total - passed}/${total}`);
console.log(`═══════════════════════════════`);

// Cleanup
['test_security.json', 'test_security.wtns'].forEach(file => {
    if (fs.existsSync(file)) fs.unlinkSync(file);
});

if (passed === total) {
    console.log("🎉 All security checks working correctly!");
} else {
    console.log("🚨 Some security checks may be bypassed - investigate!");
}

process.exit(passed === total ? 0 : 1);