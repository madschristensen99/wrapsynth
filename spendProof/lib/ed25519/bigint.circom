// bigint.circom - Big Integer Arithmetic for Ed25519
// Base 2^85 representation with 3 limbs for 255-bit numbers
// Used for field arithmetic in Ed25519 operations

pragma circom 2.1.0;

include "../../node_modules/circomlib/circuits/bitify.circom";
include "../../node_modules/@electron-labs/ed25519-circom/circuits/chunkedmul.circom";
include "../../node_modules/@electron-labs/ed25519-circom/circuits/chunkedsub.circom";
include "../../node_modules/@electron-labs/ed25519-circom/circuits/chunkify.circom";

// Ed25519 prime: p = 2^255 - 19
// Represented in base 2^85 as 3 limbs

function ed25519_p() {
    // p = 2^255 - 19
    // In base 2^85: [p0, p1, p2] where p = p0 + p1*2^85 + p2*2^170
    return [
        38685626227668133590597631,  // 2^85 - 19
        38685626227668133590597632,  // 2^85
        9903520314283042199192993792  // 2^85 mod (2^255 - 19)
    ];
}

// Ed25519 scalar field order: l = 2^252 + 27742317777372353535851937790883648493
function ed25519_l() {
    return [
        28948022309329048855892746252171976963,  // l mod 2^85
        38685626227668133590597631,              // (l >> 85) mod 2^85
        1147797409030816545                       // (l >> 170) mod 2^85
    ];
}

// Convert from base 2^85 to bits (255 bits)
template BigInt2Bits() {
    signal input in[3];  // 3 limbs in base 2^85
    signal output out[255];
    
    // Convert each limb to bits
    component limb0 = Num2Bits(85);
    component limb1 = Num2Bits(85);
    component limb2 = Num2Bits(85);
    
    limb0.in <== in[0];
    limb1.in <== in[1];
    limb2.in <== in[2];
    
    // Concatenate bits (only use 255 bits total)
    for (var i = 0; i < 85; i++) {
        out[i] <== limb0.out[i];
    }
    for (var i = 0; i < 85; i++) {
        out[85 + i] <== limb1.out[i];
    }
    for (var i = 0; i < 85; i++) {
        if (85 + 85 + i < 255) {
            out[170 + i] <== limb2.out[i];
        }
    }
}

// Convert from bits to base 2^85
template Bits2BigInt() {
    signal input in[255];
    signal output out[3];
    
    component bits2num0 = Bits2Num(85);
    component bits2num1 = Bits2Num(85);
    component bits2num2 = Bits2Num(85);
    
    for (var i = 0; i < 85; i++) {
        bits2num0.in[i] <== in[i];
    }
    for (var i = 0; i < 85; i++) {
        bits2num1.in[i] <== in[85 + i];
    }
    for (var i = 0; i < 85; i++) {
        if (170 + i < 255) {
            bits2num2.in[i] <== in[170 + i];
        } else {
            bits2num2.in[i] <== 0;
        }
    }
    
    out[0] <== bits2num0.out;
    out[1] <== bits2num1.out;
    out[2] <== bits2num2.out;
}

// Convert binary to chunked representation (base 2^85)
template BinaryToChunked85(nBits, nChunks) {
    signal input in[nBits];
    signal output out[nChunks];
    
    component bits2num[nChunks];
    for (var i = 0; i < nChunks; i++) {
        bits2num[i] = Bits2Num(85);
        for (var j = 0; j < 85; j++) {
            if (i * 85 + j < nBits) {
                bits2num[i].in[j] <== in[i * 85 + j];
            } else {
                bits2num[i].in[j] <== 0;
            }
        }
        out[i] <== bits2num[i].out;
    }
}

// Convert chunked to binary representation
template ChunkedToBinary85(nChunks, nBits) {
    signal input in[nChunks];
    signal output out[nBits];
    
    component num2bits[nChunks];
    for (var i = 0; i < nChunks; i++) {
        num2bits[i] = Num2Bits(85);
        num2bits[i].in <== in[i];
        for (var j = 0; j < 85; j++) {
            if (i * 85 + j < nBits) {
                out[i * 85 + j] <== num2bits[i].out[j];
            }
        }
    }
}

// Re-export ChunkedMul from ed25519-circom with our naming convention
// The library uses ChunkedMul(aChunks, bChunks, base) where base=85
template ChunkedMul85(aChunks, bChunks) {
    signal input a[aChunks];
    signal input b[bChunks];
    signal output out[aChunks + bChunks];
    
    component mul = ChunkedMul(aChunks, bChunks, 85);
    for (var i = 0; i < aChunks; i++) {
        mul.in1[i] <== a[i];
    }
    for (var i = 0; i < bChunks; i++) {
        mul.in2[i] <== b[i];
    }
    for (var i = 0; i < aChunks + bChunks; i++) {
        out[i] <== mul.out[i];
    }
}

// Re-export ChunkedSub from ed25519-circom
template ChunkedSub85(nChunks) {
    signal input a[nChunks];
    signal input b[nChunks];
    signal output out[nChunks];
    
    component sub = ChunkedSub(nChunks, 85);
    for (var i = 0; i < nChunks; i++) {
        sub.a[i] <== a[i];
        sub.b[i] <== b[i];
    }
    for (var i = 0; i < nChunks; i++) {
        out[i] <== sub.out[i];
    }
}
