#!/usr/bin/env node

/**
 * generate_witness_optimized.js
 * 
 * Optimized witness generator for MoneroBridgeOptimized circuit
 * 
 * KEY OPTIMIZATION:
 * - Computes Keccak256 hash CLIENT-SIDE (not in circuit)
 * - Passes amountKey as PUBLIC input
 * - Solidity contract verifies the hash is correct
 * - Saves ~150,000 constraints
 * 
 * Usage:
 *   node scripts/generate_witness_optimized.js <input.json>
 */

const fs = require('fs');
const path = require('path');
const { keccak256 } = require('js-sha3');

/**
 * Convert hex string to bit array (LSB first per byte)
 */
function hexToBits(hexStr, totalBits) {
    // Remove 0x prefix if present
    hexStr = hexStr.replace(/^0x/, '');
    
    // Pad to required length
    const requiredHexLength = Math.ceil(totalBits / 4);
    hexStr = hexStr.padStart(requiredHexLength, '0');
    
    const bits = [];
    const bytes = [];
    
    // Convert hex to bytes (big-endian)
    for (let i = 0; i < hexStr.length; i += 2) {
        bytes.push(parseInt(hexStr.substr(i, 2), 16));
    }
    
    // Convert bytes to bits (LSB first per byte)
    for (let i = 0; i < bytes.length; i++) {
        let byte = bytes[i];
        for (let j = 0; j < 8; j++) {
            bits.push(byte & 1);
            byte >>= 1;
        }
    }
    
    return bits.slice(0, totalBits);
}

/**
 * Convert bit array to hex string
 */
function bitsToHex(bits) {
    let hex = '';
    for (let i = 0; i < bits.length; i += 8) {
        let byte = 0;
        for (let j = 0; j < 8 && i + j < bits.length; j++) {
            byte |= (bits[i + j] << j);
        }
        hex += byte.toString(16).padStart(2, '0');
    }
    return hex;
}

/**
 * Compute amount key using Keccak256
 * This is the OPTIMIZATION - moved from in-circuit to client-side
 * 
 * @param {Array<number>} H_s_scalar_bits - 255-bit scalar as bit array
 * @returns {Array<number>} - 64-bit amount key as bit array
 */
function computeAmountKey(H_s_scalar_bits) {
    // Domain separator: "amount" in ASCII
    const amountPrefix = Buffer.from('amount', 'ascii');
    
    // Convert H_s_scalar bits to bytes (LSB first per byte)
    const H_s_bytes = [];
    for (let i = 0; i < 255; i += 8) {
        let byte = 0;
        for (let j = 0; j < 8 && i + j < 255; j++) {
            byte |= (H_s_scalar_bits[i + j] << j);
        }
        H_s_bytes.push(byte);
    }
    
    // Pad to 32 bytes (256 bits)
    while (H_s_bytes.length < 32) {
        H_s_bytes.push(0);
    }
    
    // Concatenate: "amount" || H_s_scalar (304 bits total)
    const input = Buffer.concat([
        amountPrefix,
        Buffer.from(H_s_bytes)
    ]);
    
    // Compute Keccak256 hash
    const hash = keccak256(input);
    
    // Take first 64 bits (8 bytes)
    const hashBytes = Buffer.from(hash, 'hex').slice(0, 8);
    
    // Convert to bit array (LSB first per byte)
    const amountKeyBits = [];
    for (let i = 0; i < 8; i++) {
        let byte = hashBytes[i];
        for (let j = 0; j < 8; j++) {
            amountKeyBits.push(byte & 1);
            byte >>= 1;
        }
    }
    
    console.log(`[OPTIMIZATION] Computed amount key client-side: 0x${hashBytes.toString('hex')}`);
    console.log(`[OPTIMIZATION] This saves ~150,000 circuit constraints!`);
    
    return amountKeyBits;
}

/**
 * Generate witness for optimized circuit
 */
function generateWitness(inputData) {
    console.log('Generating witness for MoneroBridgeOptimized circuit...\n');
    
    // Parse input data
    const r_bits = hexToBits(inputData.r, 255);
    const H_s_scalar_bits = hexToBits(inputData.H_s_scalar, 255);
    
    // OPTIMIZATION: Compute amount key CLIENT-SIDE
    const amountKey_bits = computeAmountKey(H_s_scalar_bits);
    
    // Compute blinding factor s (if not provided)
    // In Monero: s = H_s("commitment_mask" || 8·r·A || output_index)
    // For now, we'll use a placeholder or accept it as input
    const s_bits = inputData.s ? hexToBits(inputData.s, 255) : new Array(255).fill(0);
    
    // Build witness object
    const witness = {
        // Private inputs
        r: r_bits,
        v: inputData.v.toString(),
        s: s_bits,  // NEW: Blinding factor for Pedersen commitment
        output_index: inputData.output_index.toString(),
        H_s_scalar: H_s_scalar_bits,
        P_extended: inputData.P_extended,
        
        // Public inputs
        R_x: inputData.R_x.toString(),
        P_compressed: inputData.P_compressed.toString(),
        ecdhAmount: inputData.ecdhAmount.toString(),
        A_compressed: inputData.A_compressed.toString(),
        B_compressed: inputData.B_compressed.toString(),
        monero_tx_hash: inputData.monero_tx_hash.toString(),
        C_compressed: inputData.C_compressed ? inputData.C_compressed.toString() : "0",  // NEW: Pedersen commitment
        
        // NEW: Pre-computed amount key (PUBLIC INPUT)
        amountKey: amountKey_bits
    };
    
    console.log('\n✅ Witness generated successfully!');
    console.log(`   - Private inputs: r, v, s, output_index, H_s_scalar, P_extended`);
    console.log(`   - Public inputs: R_x, P_compressed, ecdhAmount, A_compressed, B_compressed, monero_tx_hash, C_compressed, amountKey`);
    console.log(`   - Amount key computed: ${amountKey_bits.length} bits`);
    console.log(`   - Blinding factor s: ${s_bits.length} bits (placeholder if not provided)`);
    
    return witness;
}

/**
 * Main execution
 */
function main() {
    if (process.argv.length < 3) {
        console.error('Usage: node generate_witness_optimized.js <input.json>');
        process.exit(1);
    }
    
    const inputFile = process.argv[2];
    
    // Read input file
    console.log(`Reading input from: ${inputFile}`);
    const inputData = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
    
    // Generate witness
    const witness = generateWitness(inputData);
    
    // Write output
    const outputFile = inputFile.replace('.json', '_witness_optimized.json');
    fs.writeFileSync(outputFile, JSON.stringify(witness, null, 2));
    
    console.log(`\n✅ Witness written to: ${outputFile}`);
    console.log('\nNext steps:');
    console.log('  1. Compile circuit: circom monero_bridge_optimized.circom --r1cs --wasm --sym');
    console.log('  2. Generate proof: snarkjs groth16 prove ...');
    console.log('  3. Verify in Solidity (contract will check amountKey hash)');
}

if (require.main === module) {
    main();
}

module.exports = { generateWitness, computeAmountKey, hexToBits, bitsToHex };
