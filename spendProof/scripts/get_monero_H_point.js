#!/usr/bin/env node

/**
 * Get Monero's H point for Pedersen commitments
 * H = HashToPoint("H") using Monero's hash-to-curve algorithm
 */

const crypto = require('crypto');
const { decompressToExtendedBase85 } = require('./ed25519_utils');

// Monero's standard H point (compressed form)
// This is from Monero's source code: src/ringct/rctTypes.h
// H = 8b655970153799af2aeadc9ff1add0ea6c7251d54154cfa92c173a0dd39c1f94
const MONERO_H_COMPRESSED = "8b655970153799af2aeadc9ff1add0ea6c7251d54154cfa92c173a0dd39c1f94";

console.log("🔧 Getting Monero H point for Pedersen commitments\n");
console.log("Compressed H:", MONERO_H_COMPRESSED);

try {
    // Decompress to extended coordinates
    const H_extended = decompressToExtendedBase85(MONERO_H_COMPRESSED);
    
    console.log("\n✅ H point in extended coordinates (base 2^85):");
    console.log("function ed25519_H() {");
    console.log("    return [");
    console.log(`        [${H_extended.X.join(', ')}],`);
    console.log(`        [${H_extended.Y.join(', ')}],`);
    console.log(`        [${H_extended.Z.join(', ')}],`);
    console.log(`        [${H_extended.T.join(', ')}]`);
    console.log("    ];");
    console.log("}");
    
    console.log("\n📋 Copy this function into monero_bridge_optimized.circom");
    console.log("   to replace the placeholder ed25519_H() function");
    
} catch (error) {
    console.error("❌ Error:", error.message);
    console.log("\n⚠️  Using standard Monero H point from documentation:");
    console.log("   This should be verified against Monero source code");
}
