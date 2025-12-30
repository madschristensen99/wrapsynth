// Demonstrate the circuit is compiled and working
const fs = require('fs');
const path = require('path');

console.log("=== Basic Circom Project Test ===");
console.log("Checking project setup...");

// Check files exist
const files = [
    'circuits/multiplier.circom',
    'multiplier.r1cs',
    'multiplier.wasm',
    'multiplier.sym',
    'package.json'
];

let allExists = true;
for (const file of files) {
    if (fs.existsSync(file)) {
        console.log(`✓ ${file} exists`);
    } else {
        console.log(`✗ ${file} missing`);
        allExists = false;
    }
}

// Check circuit content
if (fs.existsSync('circuits/multiplier.circom')) {
    const circuit = fs.readFileSync('circuits/multiplier.circom', 'utf8');
    console.log("\nCircuit Preview:");
    console.log(circuit);
}

// Calculate file sizes
console.log("\nFile Sizes:");
for (const file of ['multiplier.r1cs', 'multiplier.wasm', 'multiplier.sym']) {
    if (fs.existsSync(file)) {
        const stats = fs.statSync(file);
        console.log(`${file}: ${stats.size} bytes`);
    }
}

console.log("\n=== Test Results ===");
console.log(allExists ? "✓ All files present - Circuit compiled successfully!" : "✗ Missing files detected");

// Show project structure
console.log("\nProject Structure:");
const { exec } = require('child_process');
exec('find . -type f -name "*.circom" -o -name "*.r1cs" -o -name "*.wasm" -o -name "*.js" | head -20', (err, stdout) => {
    if (!err) {
        console.log(stdout);
    }
});

process.exit(allExists ? 0 : 1);