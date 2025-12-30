// Simple test without mocha framework
const {wasm} = require("circom_tester");
const path = require("path");

async function runTests() {
    console.log("Testing Multiplier Circuit...");
    
    const circuit = await wasm(path.join(__dirname, "../circuits/multiplier.circom"));
    
    // Test cases
    const testCases = [
        {a: 2, b: 3, expected: 6},
        {a: 5, b: 7, expected: 35},
        {a: 0, b: 10, expected: 0},
        {a: 8, b: 4, expected: 32}
    ];
    
    let passed = 0;
    for (const test of testCases) {
        try {
            const witness = await circuit.calculateWitness({a: test.a, b: test.b});
            const output = await circuit.getLastWitness(witness);
            
            if (output.main.c === test.expected) {
                console.log(`✓ ${test.a} * ${test.b} = ${test.expected}`);
                passed++;
            } else {
                console.log(`✗ ${test.a} * ${test.b} expected ${test.expected}, got ${output.main.c}`);
            }
        } catch (error) {
            console.log(`✗ ${test.a} * ${test.b} failed: ${error.message}`);
        }
    }
    
    console.log(`\nPassed: ${passed}/${testCases.length}`);
    return passed === testCases.length;
}

runTests().then(success => {
    console.log(success ? "All tests passed!" : "Some tests failed.");
    process.exit(success ? 0 : 1);
}).catch(err => {
    console.error("Error running tests:", err);
    process.exit(1);
});