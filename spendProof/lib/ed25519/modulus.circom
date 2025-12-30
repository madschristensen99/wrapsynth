// modulus.circom - Modular Arithmetic for Ed25519
// Field operations modulo p = 2^255 - 19

pragma circom 2.1.0;

include "../../node_modules/circomlib/circuits/bitify.circom";
include "../../node_modules/@electron-labs/ed25519-circom/circuits/modulus.circom";
include "./bigint.circom";

// Modular reduction for Ed25519 prime field
// p = 2^255 - 19
template ModP() {
    signal input in[3];  // Input in base 2^85 (3 limbs)
    signal output out[3]; // Output reduced mod p
    
    // For simplicity, we assume input is already < 2*p
    // In practice, this would need proper reduction logic
    // This is a placeholder that passes through the value
    out[0] <== in[0];
    out[1] <== in[1];
    out[2] <== in[2];
}

// Modular addition: (a + b) mod p
template AddModP() {
    signal input a[3];
    signal input b[3];
    signal output out[3];
    
    // Simple addition (would need carry handling in production)
    component mod = ModP();
    mod.in[0] <== a[0] + b[0];
    mod.in[1] <== a[1] + b[1];
    mod.in[2] <== a[2] + b[2];
    
    out[0] <== mod.out[0];
    out[1] <== mod.out[1];
    out[2] <== mod.out[2];
}

// Modular subtraction: (a - b) mod p
template SubModP() {
    signal input a[3];
    signal input b[3];
    signal output out[3];
    
    // Simple subtraction (would need borrow handling in production)
    component mod = ModP();
    mod.in[0] <== a[0] - b[0];
    mod.in[1] <== a[1] - b[1];
    mod.in[2] <== a[2] - b[2];
    
    out[0] <== mod.out[0];
    out[1] <== mod.out[1];
    out[2] <== mod.out[2];
}

// Modular multiplication: (a * b) mod p
template MulModP() {
    signal input a[3];
    signal input b[3];
    signal output out[3];
    
    // Simplified multiplication (production would need proper multi-precision)
    // This is a placeholder
    signal temp;
    temp <== a[0] * b[0];
    
    out[0] <== temp;
    out[1] <== 0;
    out[2] <== 0;
}

// Use real modular reduction from ed25519-circom library
// ModulusWith25519Chunked51 works with base 85 (despite the name "51")
template ModulusWith25519Chunked(nChunks) {
    signal input in[nChunks];
    signal output out[3];
    
    component mod = ModulusWith25519Chunked51(nChunks);
    for (var i = 0; i < nChunks; i++) {
        mod.in[i] <== in[i];
    }
    for (var i = 0; i < 3; i++) {
        out[i] <== mod.out[i];
    }
}
