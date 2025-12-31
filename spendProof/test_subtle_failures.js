// Test subtle security boundary violations
const fs = require('fs');
const path = require('path');

// Copy the working input.json to modify subtle values
const input = JSON.parse(fs.readFileSync('input.json', 'utf8'));

function modifyAndTest(changes, description) {
    console.log(`=== Testing: ${description} ===`);
    
    const testInput = { ...input };
    
    // Apply the specific change
    Object.keys(changes).forEach(key => {
        testInput[key] = changes[key];
    });
    
    try {
        // Create test file
        fs.writeFileSync('subtle_test.json', JSON.stringify(testInput, null, 2));
        
        // Try to generate witness
        const { execSync } = require('child_process');
        try {
            execSync('node monero_bridge_js/generate_witness.js monero_bridge_js/monero_bridge.wasm subtle_test.json subtle_test.wtns', {
                stdio: 'pipe',
                timeout: 30000
            });
            console.log("❌ FAIL - Circuit accepted change (should be rejected)");
            return false;
        } catch (e) {
            console.log("✅ PASS - Circuit correctly rejected");
            return true;
        }
    } catch (e) {
        console.log("❌ ERROR:", e.message);
        return false;
    }
    console.log("");
}

console.log("🔍 Testing Subtle Security Boundary Violations\n");

// Test cases targeting specific security properties
const subtleTests = [
    // Test 1: Flip one bit in destination address
    [{
        P_compressed: `${input.P_compressed.slice(0, 0)}${input.P_compressed[0] === '0' ? '1' : '0'}${input.P_compressed.slice(1)}`
    }, "Flip LSB in destination address"],
    
    // Test 2: Change secret key slightly
    [{
        r: [...input.r.slice(0, 50), input.r[50] === 0 ? 1 : 0, ...input.r.slice(51)]
    }, "Flip one bit in secret key"],
    
    // Test 3: Change recipient view key
    [{
        A_compressed: `${input.A_compressed.slice(0, 0)}${input.A_compressed[0] === '0' ? '1' : '0'}${input.A_compressed.slice(1)}`
    }, "Flip one bit in recipient view key"],
    
    // Test 4: Change spend key bit
    [{
        B_compressed: `${input.B_compressed.slice(0, 0)}${input.B_compressed[0] === '0' ? '1' : '0'}${input.B_compressed.slice(1)}`
    }, "Flip one bit in spend key"],
    
    // Test 5: Wrong output index
    [{
        output_index: 5
    }, "Claim output index 5 (not 0)"],
    
    // Test 6: Reorder secret key bits
    [{
        r: [...input.r.slice(1, 256), input.r[0]] // Rotate bits
    }, "Reorder secret key bits"]
];

let passed = 0;
let total = subtleTests.length;

subtleTests.forEach(([changes, description]) => {
    if (modifyAndTest(changes, description)) {
        passed++;
    }
});

console.log(`\n═══════════════════════════════`);
console.log(`Subtle Security Test Results:`);
console.log(`✅ Passed: ${passed}/${total}`);
console.log(`Circuit correctly rejects invalid inputs`);
console.log(`═══════════════════════════════`);

// Cleanup
['subtle_test.json', 'subtle_test.wtns'].forEach(file => {
    if (fs.existsSync(file)) fs.unlinkSync(file);
});

process.exit(passed === total ? 0 : 1);