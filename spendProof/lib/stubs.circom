// Temporary stubs for missing hash functions
// TODO: Replace with real implementations

pragma circom 2.1.0;

include "../node_modules/circomlib/circuits/bitify.circom";

// Stub Blake2s - just returns zeros
template Blake2s256(nBits) {
    signal input in[nBits];
    signal output out[256];
    
    for (var i = 0; i < 256; i++) {
        out[i] <== 0;
    }
}

// Stub Keccak256 - just returns zeros  
template Keccak256(nBits) {
    signal input in[nBits];
    signal output out[256];
    
    for (var i = 0; i < 256; i++) {
        out[i] <== 0;
    }
}

// XOR is provided by circomlib gates.circom
