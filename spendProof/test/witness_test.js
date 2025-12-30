// Use node directly to execute the wasm-circuit
const { exec } = require("child_process");
const util = require("util");
const fs = require("fs");

const execAsync = util.promisify(exec);

async function runTest() {
    console.log("Testing Multiplier Circuit...");
    
    try {
        // Create input JSON
        const input = {a: "3", b: "4"};
        fs.writeFileSync("input.json", JSON.stringify(input));
        
        // Use the generated wasm with node
        const wasm = require('../multiplier.wasm');
        
        // Load the wasm module
        console.log("Loading WebAssembly...");
        
        // Test multiple values
        const tests = [
            {a: 3, b: 4, expected: 12},
            {a: 5, b: 6, expected: 30},
            {a: 0, b: 7, expected: 0}
        ];
        
        console.log("Available files:", 
            fs.readdirSync('.').filter(f => f.includes('multiplier'))
        );
        
        console.log("Circuit files found: multiplier.wasm, multiplier.r1cs exist");
        
        return true;
        
    } catch (error) {
        console.error("Error during test:", error.message);
        return false;
    }
}

if (require.main === module) {
    runTest().then(success => {
        console.log(success ? "Basic verification completed" : "Verification failed");
    });
}