pragma circom 2.0.0;

include "node_modules/circomlib/circuits/bitify.circom";

/*
 * Field element to bytes conversion
 * Converts a field element to 32-byte representation
 * Used for hashing operations
 */

template FieldToBytes() {
    signal input in;            // Field element (BN254)
    signal output out[32];      // 32 bytes (each 8 bits)
    
    // Convert field element to bits
    component bits = Num2Bits(256);
    bits.in <== in;
    
    // Group bits into bytes
    // BN254 field uses little-endian representation
    for (var i = 0; i < 32; i++) {
        out[i] = 0;
        for (var j = 0; j < 8; j++) {
            out[i] = out[i] + (bits.out[i * 8 + j] * (1 << j));
        }
    }
}

/*
 * XOR operation on 64-bit integers
 * Limited to 64-bit for amount decryption
 */
template XOR64() {
    signal input a;
    signal input b;
    signal output out;
    
    component aBits = Num2Bits(64);
    component bBits = Num2Bits(64);
    component xorBits[64];
    component outNum = Bits2Num(64);
    
    aBits.in <== a;
    bBits.in <== b;
    
    // XOR each bit
    for (var i = 0; i < 64; i++) {
        xorBits[i] = Xor();
        xorBits[i].a <== aBits.out[i];
        xorBits[i].b <== bBits.out[i];
        outNum.in[i] <== xorBits[i].out;
    }
    
    out <== outNum.out;
}