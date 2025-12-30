// Manual test using snarkjs with wasm to verify circuit works
const snarkjs = require("snarkjs");
const path = require("path");

async function testCircuit() {
    console.log("Testing Multiplier Circuit...");
    
    try {
        // Test with inputs a=3, b=4, expecting c=12
        const input = {a: 3, b: 4};
        
        // Use the circuit wasm file directly
        const wasmPath = "./multiplier.wasm";
        const zkeyPath = "./multiplier.zkey";
        
        console.log("Input:", input);
        
        // Generate witness using snarkjs
        const { witness } = await snarkjs.wtns.calculate(input, wasmPath);
        
        // Read the expected output from witness (main.c should be at index 1)
        // In Circom, output should be at witness[1]
        console.log("Witness length:", witness.length);
        console.log("Output value (at index 1):", witness[1]?.toString());
        
        if (witness[1] === 12n) {
            console.log("✓ Test passed! 3 * 4 = 12");
            return true;
        } else {
            console.log(`✗ Expected 12, got ${witness[1]}`);
            return false;
        }
        
    } catch (error) {
        console.error("Error testing circuit:", error.message);
        return false;
    }
}

testCircuit().then(success => {
    console.log(success ? "Test completed successfully!" : "Test failed");
    process.exit(success ? 0 : 1);
});