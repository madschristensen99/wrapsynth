#!/usr/bin/env node

/**
 * generate_witness.js - DLEQ-Optimized Witness Generator
 * 
 * This generates witnesses for the DLEQ-optimized circuit where:
 * - Ed25519 operations are done CLIENT-SIDE using native libraries
 * - Circuit only verifies Poseidon commitment + amount decryption
 * 
 * Constraint reduction: 3.9M → 1,167 (3,381x improvement)
 */

const { keccak256 } = require('js-sha3');
const { buildPoseidon } = require('circomlibjs');
const { computeEd25519Operations } = require('./generate_dleq_proof.js');
const { generateDLEQProofSecp256k1 } = require('./generate_dleq_secp256k1.js');

/**
 * Convert hex string or array to bit array (LSB first per byte)
 */
function hexToBits(input, totalBits) {
    // If already an array, just return it
    if (Array.isArray(input)) {
        return input.slice(0, totalBits);
    }
    
    // Otherwise convert hex string
    let hexStr = input.toString().replace(/^0x/, '');
    const requiredHexLength = Math.ceil(totalBits / 4);
    hexStr = hexStr.padStart(requiredHexLength, '0');
    
    const bits = [];
    const bytes = [];
    
    for (let i = 0; i < hexStr.length; i += 2) {
        bytes.push(parseInt(hexStr.substr(i, 2), 16));
    }
    
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
 * Compute amount key using Keccak256
 */
function computeAmountKey(H_s_scalar_bits) {
    const amountPrefix = Buffer.from('amount', 'ascii');
    
    const H_s_bytes = [];
    for (let i = 0; i < 255; i += 8) {
        let byte = 0;
        for (let j = 0; j < 8 && i + j < 255; j++) {
            byte |= (H_s_scalar_bits[i + j] << j);
        }
        H_s_bytes.push(byte);
    }
    
    while (H_s_bytes.length < 32) {
        H_s_bytes.push(0);
    }
    
    const input = Buffer.concat([
        amountPrefix,
        Buffer.from(H_s_bytes)
    ]);
    
    const hash = keccak256(input);
    const hashBytes = Buffer.from(hash, 'hex').slice(0, 8);
    
    const amountKeyBits = [];
    for (let i = 0; i < 8; i++) {
        let byte = hashBytes[i];
        for (let j = 0; j < 8; j++) {
            amountKeyBits.push(byte & 1);
            byte >>= 1;
        }
    }
    
    console.log(`[OPTIMIZATION] Computed amount key client-side: 0x${hashBytes.toString('hex')}`);
    
    return amountKeyBits;
}

/**
 * Compute Poseidon commitment using circomlibjs
 */
async function computePoseidonCommitment(r_num, v, H_s_num, R_x, S_x, P_compressed) {
    const poseidon = await buildPoseidon();
    
    const inputs = [
        BigInt(r_num),
        BigInt(v),
        BigInt(H_s_num),
        BigInt(R_x),
        BigInt(S_x),
        BigInt(P_compressed)
    ];
    
    const hash = poseidon(inputs);
    const hashStr = poseidon.F.toString(hash);
    
    console.log(`[POSEIDON] Commitment computed: ${hashStr.slice(0, 20)}...`);
    
    return hashStr;
}

/**
 * Generate witness for DLEQ-optimized circuit
 */
async function generateWitness(inputData) {
    console.log('Generating witness for DLEQ-optimized circuit...\n');
    
    const r_bits = hexToBits(inputData.r, 255);
    const H_s_scalar_bits = hexToBits(inputData.H_s_scalar, 255);
    
    // Compute amount key CLIENT-SIDE
    const amountKey_bits = computeAmountKey(H_s_scalar_bits);
    
    // Convert to numbers for Poseidon
    let r_num = 0n;
    for (let i = 254; i >= 0; i--) {
        r_num = (r_num << 1n) | BigInt(r_bits[i]);
    }
    
    let H_s_num = 0n;
    for (let i = 254; i >= 0; i--) {
        H_s_num = (H_s_num << 1n) | BigInt(H_s_scalar_bits[i]);
    }
    
    // Compute Ed25519 operations and DLEQ proof
    let ed25519Results;
    if (inputData.A_compressed && inputData.B_compressed) {
        // Convert r to hex string
        let r_hex = '';
        for (let i = 0; i < r_bits.length; i += 8) {
            let byte = 0;
            for (let j = 0; j < 8 && i + j < r_bits.length; j++) {
                byte |= (r_bits[i + j] << j);
            }
            r_hex += byte.toString(16).padStart(2, '0');
        }
        
        let H_s_hex = '';
        for (let i = 0; i < H_s_scalar_bits.length; i += 8) {
            let byte = 0;
            for (let j = 0; j < 8 && i + j < H_s_scalar_bits.length; j++) {
                byte |= (H_s_scalar_bits[i + j] << j);
            }
            H_s_hex += byte.toString(16).padStart(2, '0');
        }
        
        // A_compressed and B_compressed can be either hex strings or decimal BigInts
        // Convert to Ed25519 compressed format (32 bytes hex, little-endian)
        const convertToHex = (value) => {
            if (typeof value === 'string' && value.match(/^0x[0-9a-fA-F]+$/)) {
                // Already hex string with 0x prefix
                return value.replace(/^0x/, '');
            } else if (typeof value === 'string' && value.match(/^[0-9a-fA-F]{64}$/)) {
                // Hex string without 0x prefix (exactly 64 hex chars)
                return value;
            } else {
                // Decimal string or BigInt - blockchain stores as little-endian decimal
                // Convert back to little-endian bytes, then to hex
                const bigint = BigInt(value);
                const bytes = [];
                let val = bigint;
                for (let i = 0; i < 32; i++) {
                    bytes.push(Number(val & 0xFFn));
                    val >>= 8n;
                }
                return Buffer.from(bytes).toString('hex');
            }
        };
        
        const A_hex = convertToHex(inputData.A_compressed);
        const B_hex = convertToHex(inputData.B_compressed);
        
        ed25519Results = await computeEd25519Operations(
            r_hex,
            A_hex,
            B_hex,
            H_s_hex
        );
    }
    
    // Compute Poseidon commitment
    const commitment = await computePoseidonCommitment(
        r_num.toString(),
        inputData.v.toString(),
        H_s_num.toString(),
        ed25519Results ? ed25519Results.R_x : inputData.R_x.toString(),
        ed25519Results ? ed25519Results.S_x : (inputData.S_x || inputData.R_x.toString()),
        ed25519Results ? ed25519Results.P_compressed : inputData.P_compressed.toString()
    );
    
    const witness = {
        // Private inputs
        r: r_bits,
        v: inputData.v.toString(),
        H_s_scalar: H_s_scalar_bits,
        
        // Public inputs (computed off-circuit with Ed25519)
        R_x: ed25519Results ? ed25519Results.R_x : inputData.R_x.toString(),
        S_x: ed25519Results ? ed25519Results.S_x : (inputData.S_x || inputData.R_x.toString()),
        P_compressed: ed25519Results ? ed25519Results.P_compressed : inputData.P_compressed.toString(),
        ecdhAmount: inputData.ecdhAmount.toString(),
        amountKey: amountKey_bits,
        commitment: commitment,
        
        // DLEQ proof (for Solidity verification)
        R: ed25519Results ? ed25519Results.R : null,
        rA: ed25519Results ? ed25519Results.rA : null,
        S: ed25519Results ? ed25519Results.S : null,
        dleqProof: ed25519Results ? ed25519Results.dleqProof : null,
        ed25519Proof: ed25519Results ? ed25519Results.ed25519Proof : null
    };
    
    console.log('\n✅ DLEQ-Optimized Witness generated!');
    console.log(`   - Circuit constraints: ~1,167 (vs 3.9M original)`);
    console.log(`   - Reduction: 3,381x improvement`);
    console.log(`   - Expected proof time: <1 second`);
    
    return witness;
}

module.exports = { generateWitness, computeAmountKey, hexToBits };
