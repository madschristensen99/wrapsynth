// Test circuit with real and fake data
const fs = require('fs');
const { execSync } = require('child_process');

console.log("🧪 Testing Monero Bridge Circuit\n");

// Test 1: Real data (should PASS)
console.log("Test 1: Real Monero transaction data");
try {
    execSync('snarkjs wtns calculate monero_bridge_js/monero_bridge.wasm input.json witness.wtns', {
        cwd: '/home/remsee/circuitDev/spendProof',
        stdio: 'pipe'
    });
    console.log("✅ PASS - Real data accepted\n");
} catch (e) {
    console.log("❌ FAIL - Real data rejected (unexpected!)\n");
}

// Test 2: Wrong secret key (should FAIL)
console.log("Test 2: Wrong secret key (r)");
const realInput = JSON.parse(fs.readFileSync('input.json', 'utf8'));
const wrongR = JSON.parse(JSON.stringify(realInput));
// Flip some bits in the secret key
wrongR.r[0] = wrongR.r[0] === "0" ? "1" : "0";
wrongR.r[10] = wrongR.r[10] === "0" ? "1" : "0";
fs.writeFileSync('input_wrong_r.json', JSON.stringify(wrongR, null, 2));

try {
    execSync('snarkjs wtns calculate monero_bridge_js/monero_bridge.wasm input_wrong_r.json witness_wrong_r.wtns', {
        cwd: '/home/remsee/circuitDev/spendProof',
        stdio: 'pipe'
    });
    console.log("❌ FAIL - Wrong secret key accepted (security issue!)\n");
} catch (e) {
    console.log("✅ PASS - Wrong secret key rejected\n");
}

// Test 3: Wrong amount (fraud case - should fail but currently passes)
console.log("Test 3: Correct secret key but wrong amount (fraud case)");
const wrongAmount = JSON.parse(JSON.stringify(realInput));
// Real amount is 20000000000, let's claim 100000000000 (5x more)
wrongAmount.v = "100000000000";
fs.writeFileSync('input_wrong_amount.json', JSON.stringify(wrongAmount, null, 2));

try {
    execSync('snarkjs wtns calculate monero_bridge_js/monero_bridge.wasm input_wrong_amount.json witness_wrong_amount.wtns', {
        cwd: '/home/remsee/circuitDev/spendProof',
        stdio: 'pipe'
    });
    console.log("⚠️  PASS (FRAUD!) - Wrong amount accepted (amount verification disabled)");
    console.log("    Real amount: 20000000000 piconero (0.02 XMR)");
    console.log("    Claimed: 100000000000 piconero (0.1 XMR)");
    console.log("    ⚠️  This fraud would be caught once amount decryption is enabled!\n");
} catch (e) {
    console.log("✅ FAIL - Wrong amount rejected (amount verification working)\n");
}

// Test 4: Wrong destination address (should FAIL - tests destination verification)
console.log("Test 4: Wrong destination address (P_compressed)");
const wrongDest = JSON.parse(JSON.stringify(realInput));
// Flip bit 10 in P_compressed (similar to Test 2 approach)
const pBigInt = BigInt(wrongDest.P_compressed);
wrongDest.P_compressed = (pBigInt ^ (1n << 10n)).toString(); // XOR to flip bit 10
fs.writeFileSync('input_wrong_dest.json', JSON.stringify(wrongDest, null, 2));

try {
    execSync('snarkjs wtns calculate monero_bridge_js/monero_bridge.wasm input_wrong_dest.json witness_wrong_dest.wtns', {
        cwd: '/home/remsee/circuitDev/spendProof',
        stdio: 'pipe'
    });
    console.log("❌ FAIL - Wrong destination accepted (security issue!)");
    console.log("    User claims they sent to LP address");
    console.log("    But P derivation check should have caught this!\n");
} catch (e) {
    console.log("✅ PASS - Wrong destination rejected (P = H_s(8·r·A)·G + B check working)\n");
}

console.log("═══════════════════════════════════════");
console.log("Test Summary:");
console.log("");
console.log("✅ WORKING Security Properties:");
console.log("  1. Secret key verification (r·G = R)");
console.log("  2. Destination verification (P = H_s(8·r·A)·G + B)");
console.log("");
console.log("⚠️  DISABLED Security Properties:");
console.log("  3. Amount verification (Pedersen commitment)");
console.log("  4. Replay protection (binding hash)");
console.log("");
console.log("🚨 CRITICAL: Tests 3 shows amount fraud is possible!");
console.log("   User can claim 5x the actual amount and circuit accepts it.");
console.log("");
console.log("✅ What's Proven: User knows secret key + sent to correct address");
console.log("❌ What's NOT Proven: Correct amount + no replay attacks");
console.log("═══════════════════════════════════════");
