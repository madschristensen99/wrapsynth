// SPDX-License-Identifier: MIT
pragma circom 2.1.0;

// ─────────────────────────────────────────────────────────────────────────────
// Imports
// ─────────────────────────────────────────────────────────────────────────────

include "circomlib/circuits/poseidon.circom";
include "circomlib/circuits/bitify.circom";
include "circomlib/circuits/comparators.circom";
include "circomlib/circuits/gates.circom";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

// Domain separation tag (must match Solidity)
template DomainTag() {
    signal output out;
    out <== 0x4d4f4e45524f5f425249444745; // "MONERO_BRIDGE"
}

// ─────────────────────────────────────────────────────────────────────────────
// Main circuit
// ─────────────────────────────────────────────────────────────────────────────

template MoneroBridgeV2() {

    // ───── Private inputs (witness) ─────
    signal input r_bits[255];          // secret scalar r
    signal input Hs_bits[255];         // shared secret scalar
    signal input v;                    // decrypted amount (piconero)

    // ───── Public inputs ─────
    signal input R_x;                  // tx public key (x)
    signal input S_x;                  // shared secret point (x)
    signal input output_commitment;    // Monero Pedersen commitment
    signal input ecdhAmount;           // encrypted amount
    signal input amountKey_bits[64];   // keccak("amount" || Hs)[0..64]
    signal input commitment;           // Poseidon binding

    signal output verified_amount;

    // ─────────────────────────────────────────────────────────────────────────
    // Bit packing
    // ─────────────────────────────────────────────────────────────────────────

    component r_num = Bits2Num(255);
    component Hs_num = Bits2Num(255);

    for (var i = 0; i < 255; i++) {
        r_num.in[i] <== r_bits[i];
        Hs_num.in[i] <== Hs_bits[i];
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Poseidon binding
    // ─────────────────────────────────────────────────────────────────────────

    component domain = DomainTag();

    component hash = Poseidon(8);
    hash.inputs[0] <== domain.out;
    hash.inputs[1] <== r_num.out;
    hash.inputs[2] <== Hs_num.out;
    hash.inputs[3] <== v;
    hash.inputs[4] <== R_x;
    hash.inputs[5] <== S_x;
    hash.inputs[6] <== output_commitment;
    hash.inputs[7] <== ecdhAmount;

    commitment === hash.out;

    // ─────────────────────────────────────────────────────────────────────────
    // Amount decryption
    // ─────────────────────────────────────────────────────────────────────────

    component ecdhBits = Num2Bits(64);
    ecdhBits.in <== ecdhAmount;

    signal decryptedBits[64];
    component xor[64];

    for (var i = 0; i < 64; i++) {
        xor[i] = XOR();
        xor[i].a <== ecdhBits.out[i];
        xor[i].b <== amountKey_bits[i];
        decryptedBits[i] <== xor[i].out;
    }

    component decrypted = Bits2Num(64);
    for (var i = 0; i < 64; i++) {
        decrypted.in[i] <== decryptedBits[i];
    }

    decrypted.out === v;

    // ─────────────────────────────────────────────────────────────────────────
    // Range checks
    // ─────────────────────────────────────────────────────────────────────────

    // v > 0
    component gt = GreaterThan(64);
    gt.in[0] <== v;
    gt.in[1] <== 0;
    gt.out === 1;

    // r < 2^252
    r_bits[252] === 0;
    r_bits[253] === 0;
    r_bits[254] === 0;

    // Hs < 2^252
    Hs_bits[252] === 0;
    Hs_bits[253] === 0;
    Hs_bits[254] === 0;

    // ─────────────────────────────────────────────────────────────────────────
    // Output
    // ─────────────────────────────────────────────────────────────────────────

    verified_amount <== v;
}

// ─────────────────────────────────────────────────────────────────────────────
// Public interface
// ─────────────────────────────────────────────────────────────────────────────

component main { public [
    R_x,
    S_x,
    output_commitment,
    ecdhAmount,
    amountKey_bits,
    commitment
]} = MoneroBridgeV2();
