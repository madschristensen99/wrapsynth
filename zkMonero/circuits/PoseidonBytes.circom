pragma circom 2.0.0;

include "node_modules/circomlib/circuits/poseidon.circom";

/*
 * Poseidon hash for byte arrays
 * Efficient hashing of fixed-length byte arrays
 */

template PoseidonBytes(n) {
    signal input inputs[n];     // Input bytes (as integers 0-255)
    signal output out;
    
    component hasher = Poseidon(n);
    
    for (var i = 0; i < n; i++) {
        hasher.inputs[i] <== inputs[i];
    }
    
    out <== hasher.out;
}

/*
 * Range check for 64-bit unsigned integers
 * Ensures value is in range [0, 2^64 - 1]
 */
template RangeCheck64() {
    signal input in;
    signal output out;
    
    component isInRange = LessEqThan(64);
    component bits = Num2Bits(64);
    
    bits.in <== in;
    isInRange.in[0] <== in;
    isInRange.in[1] <== 0xFFFFFFFFFFFFFFFF;  // 2^64 - 1
    
    isInRange.out === 1;
    out <== in;
}