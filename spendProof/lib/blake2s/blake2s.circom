// blake2s.circom - Blake2s-256 Hash Function
// Using real Blake2s from hash-circuits library

pragma circom 2.1.0;

include "../../node_modules/hash-circuits/circuits/blake2/blake2s.circom";
include "../../node_modules/circomlib/circuits/bitify.circom";

// Wrapper that converts bits to bytes and calls real Blake2s
template Blake2s256(nBits) {
    signal input in[nBits];
    signal output out[256];
    
    // Convert bits to bytes
    var nBytes = (nBits + 7) \ 8;
    component bits2bytes[nBytes];
    signal bytes[nBytes];
    
    for (var i = 0; i < nBytes; i++) {
        bits2bytes[i] = Bits2Num(8);
        for (var j = 0; j < 8; j++) {
            var bitIdx = i * 8 + j;
            if (bitIdx < nBits) {
                bits2bytes[i].in[j] <== in[bitIdx];
            } else {
                bits2bytes[i].in[j] <== 0;
            }
        }
        bytes[i] <== bits2bytes[i].out;
    }
    
    // Call real Blake2s
    component blake2s = Blake2s_bytes(nBytes);
    for (var i = 0; i < nBytes; i++) {
        blake2s.inp_bytes[i] <== bytes[i];
    }
    
    // Output is already in bits
    for (var i = 0; i < 256; i++) {
        out[i] <== blake2s.hash_bits[i];
    }
}
