// Simple witness test using the wasm directly
const { readFileSync } = require("fs");
const path = require("path");

async function createWitnessTest() {
    console.log("Testing Multiplier Circuit...");
    
    try {
        const snarkjs = require('snarkjs');
        
        const input = {a: 3, b: 4};
        console.log("Testing inputs:", input);
        
        const {witness} = await snarkjs.wtns.calculate(input, "./multiplier.wasm");
        
        console.log("Output (at witness[1]):", witness[1]?.toString());
        
        // The circuit constraint check: if 3*4=12, then witness[1] should be 12
        // For multiplier circuit: witness[1] = a * b
        const expected = 12n;
        const actual = witness[1];
        
        if (actual === expected) {
            console.log("✓ Test passed!");
            console.log(`✓ ${input.a} * ${input.b} = ${actual}`);
            return true;
        } else {
            console.log(`✗ Expected ${expected}, got ${actual}`);
            return false;
        }
        
    } catch (error) {
        console.error("Test failed:", error.message);
        return false;
    }
}

if (require.main === module) {
    createWitnessTest().then(success => {
        if (success) {
            console.log("Circuit is working correctly!");
        } else {
            console.log("Circuit test failed");
        }
        process.exit(success ? 0 : 1);
    });
}

module.exports = { createWitnessTest };