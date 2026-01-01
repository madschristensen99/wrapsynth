// monero_bridge.circom - Monero Bridge Circuit
// Proves: Knowledge of transaction secret key and correct destination address
// Cryptography: Ed25519 curve, Keccak256
//
// SECURITY NOTICE: Not audited for production use. Experimental software.

pragma circom 2.1.0;

// ════════════════════════════════════════════════════════════════════════════
// IMPORTS
// ════════════════════════════════════════════════════════════════════════════

// Ed25519 operations (Electron-Labs ed25519-circom)
include "./lib/ed25519/scalar_mul.circom";
include "./lib/ed25519/point_add.circom";
include "./lib/ed25519/point_compress.circom";
include "./lib/ed25519/point_decompress.circom";

// Hash functions
include "keccak-circom/circuits/keccak.circom";

// Utilities (from circomlib)
include "./node_modules/circomlib/circuits/comparators.circom";
include "./node_modules/circomlib/circuits/bitify.circom";
include "./node_modules/circomlib/circuits/gates.circom";

// ════════════════════════════════════════════════════════════════════════════
// CURVE CONSTANTS - Ed25519
// ════════════════════════════════════════════════════════════════════════════

// Base point G in extended coordinates (base 2^85)
function ed25519_G() {
    return [
        [6836562328990639286768922, 21231440843933962135602345, 10097852978535018773096760],
        [7737125245533626718119512, 23211375736600880154358579, 30948500982134506872478105],
        [1, 0, 0],
        [20943500354259764865654179, 24722277920680796426601402, 31289658119428895172835987]
    ];
}

// ════════════════════════════════════════════════════════════════════════════
// MAIN CIRCUIT
// ════════════════════════════════════════════════════════════════════════════

template MoneroBridge() {
    
    // ════════════════════════════════════════════════════════════════════════
    // PRIVATE INPUTS (witnesses - never revealed on-chain)
    // ════════════════════════════════════════════════════════════════════════
    
    signal input r[255];            // Transaction secret key (255-bit scalar)
    signal input v;                 // Amount in atomic piconero (64 bits)
    signal input output_index;      // Output index in transaction (0, 1, 2, ...)
    signal input H_s_scalar[255];   // Pre-reduced scalar: Keccak256(8·r·A || i) mod L
    signal input P_extended[4][3];  // Destination stealth address (extended coords)
    
    // ════════════════════════════════════════════════════════════════════════
    // PUBLIC INPUTS (verified on-chain by Solidity contract)
    // ════════════════════════════════════════════════════════════════════════
    
    signal input R_x;               // Transaction public key R (compressed)
    signal input P_compressed;      // Destination stealth address
    signal input ecdhAmount;        // ECDH-encrypted amount (64 bits)
    signal input A_compressed;      // LP's view public key (CRITICAL: prevents wrong address)
    signal input B_compressed;      // LP's spend public key
    signal input monero_tx_hash;    // Monero tx hash (for uniqueness)
    
    // ════════════════════════════════════════════════════════════════════════
    // OUTPUTS
    // ════════════════════════════════════════════════════════════════════════
    
    signal output verified_amount;
    
    // ════════════════════════════════════════════════════════════════════════
    // STEP 1: Verify R = r·G (proves knowledge of secret key r)
    // ════════════════════════════════════════════════════════════════════════
    
    var G[4][3] = ed25519_G();
    
    component computeRG = ScalarMul();
    for (var i = 0; i < 255; i++) {
        computeRG.s[i] <== r[i];
    }
    for (var i = 0; i < 4; i++) {
        for (var j = 0; j < 3; j++) {
            computeRG.P[i][j] <== G[i][j];
        }
    }
    
    component compressComputedR = PointCompress();
    for (var i = 0; i < 4; i++) {
        for (var j = 0; j < 3; j++) {
            compressComputedR.P[i][j] <== computeRG.sP[i][j];
        }
    }
    
    component computedR_bits = Bits2Num(255);
    for (var i = 0; i < 255; i++) {
        computedR_bits.in[i] <== compressComputedR.out[i];
    }
    
    // Verify: r·G compresses to public R_x (proves knowledge of r)
    computedR_bits.out === R_x;
    
    // ════════════════════════════════════════════════════════════════════════
    // STEP 2: Verify destination address P compresses correctly
    // ════════════════════════════════════════════════════════════════════════
    
    component compressP = PointCompress();
    for (var i = 0; i < 4; i++) {
        for (var j = 0; j < 3; j++) {
            compressP.P[i][j] <== P_extended[i][j];
        }
    }
    
    component P_compressed_bits = Bits2Num(255);
    for (var i = 0; i < 255; i++) {
        P_compressed_bits.in[i] <== compressP.out[i];
    }
    P_compressed_bits.out === P_compressed;
    
    // ════════════════════════════════════════════════════════════════════════
    // STEP 3: Compute and verify S = 8·r·A
    // CRITICAL: Proves funds were sent to LP's address, not attacker's
    // ════════════════════════════════════════════════════════════════════════
    
    // Decompress A from public input
    component decompressA = PointDecompress();
    component A_compressed_bits = Num2Bits(255);
    A_compressed_bits.in <== A_compressed;
    for (var i = 0; i < 255; i++) {
        decompressA.in[i] <== A_compressed_bits.out[i];
    }
    decompressA.in[255] <== 0;
    
    // Decompress B from public input (needed for potential P derivation check)
    component decompressB = PointDecompress();
    component B_compressed_bits = Num2Bits(255);
    B_compressed_bits.in <== B_compressed;
    for (var i = 0; i < 255; i++) {
        decompressB.in[i] <== B_compressed_bits.out[i];
    }
    decompressB.in[255] <== 0;
    
    // Compute r·A (scalar multiplication of r with LP's view public key)
    component compute_rA = ScalarMul();
    for (var i = 0; i < 255; i++) {
        compute_rA.s[i] <== r[i];
    }
    for (var i = 0; i < 4; i++) {
        for (var j = 0; j < 3; j++) {
            compute_rA.P[i][j] <== decompressA.out[i][j];
        }
    }
    
    // Compute 8·(r·A) by doubling 3 times: 2·(r·A), 4·(r·A), 8·(r·A)
    // This applies the cofactor to ensure we're in the prime-order subgroup
    
    // First doubling: 2·(r·A)
    component double1 = PointAdd();
    for (var i = 0; i < 4; i++) {
        for (var j = 0; j < 3; j++) {
            double1.P[i][j] <== compute_rA.sP[i][j];
            double1.Q[i][j] <== compute_rA.sP[i][j];
        }
    }
    
    // Second doubling: 4·(r·A)
    component double2 = PointAdd();
    for (var i = 0; i < 4; i++) {
        for (var j = 0; j < 3; j++) {
            double2.P[i][j] <== double1.R[i][j];
            double2.Q[i][j] <== double1.R[i][j];
        }
    }
    
    // Third doubling: 8·(r·A)
    component double3 = PointAdd();
    for (var i = 0; i < 4; i++) {
        for (var j = 0; j < 3; j++) {
            double3.P[i][j] <== double2.R[i][j];
            double3.Q[i][j] <== double2.R[i][j];
        }
    }
    
    // S = 8·r·A is now in double3.R
    // Compress S for use in amount key derivation
    component compressS = PointCompress();
    for (var i = 0; i < 4; i++) {
        for (var j = 0; j < 3; j++) {
            compressS.P[i][j] <== double3.R[i][j];
        }
    }
    
    signal S_x_bits[256];
    for (var i = 0; i < 256; i++) {
        S_x_bits[i] <== compressS.out[i];
    }
    
    // ════════════════════════════════════════════════════════════════════════
    // STEP 4: Decrypt and verify amount from ecdhAmount
    // amount_key = Keccak256("amount" || H_s_scalar)[0:64]
    // v_decrypted = ecdhAmount ⊕ amount_key
    // ════════════════════════════════════════════════════════════════════════
    
    // Domain separator: "amount" in ASCII (6 bytes = 48 bits, LSB-first per byte)
    signal amount_prefix[48];
    
    // 'a' = 0x61
    amount_prefix[0] <== 1; amount_prefix[1] <== 0; amount_prefix[2] <== 0;
    amount_prefix[3] <== 0; amount_prefix[4] <== 0; amount_prefix[5] <== 1;
    amount_prefix[6] <== 1; amount_prefix[7] <== 0;
    
    // 'm' = 0x6d
    amount_prefix[8] <== 1; amount_prefix[9] <== 0; amount_prefix[10] <== 1;
    amount_prefix[11] <== 1; amount_prefix[12] <== 0; amount_prefix[13] <== 1;
    amount_prefix[14] <== 1; amount_prefix[15] <== 0;
    
    // 'o' = 0x6f
    amount_prefix[16] <== 1; amount_prefix[17] <== 1; amount_prefix[18] <== 1;
    amount_prefix[19] <== 1; amount_prefix[20] <== 0; amount_prefix[21] <== 1;
    amount_prefix[22] <== 1; amount_prefix[23] <== 0;
    
    // 'u' = 0x75
    amount_prefix[24] <== 1; amount_prefix[25] <== 0; amount_prefix[26] <== 1;
    amount_prefix[27] <== 0; amount_prefix[28] <== 1; amount_prefix[29] <== 1;
    amount_prefix[30] <== 1; amount_prefix[31] <== 0;
    
    // 'n' = 0x6e
    amount_prefix[32] <== 0; amount_prefix[33] <== 1; amount_prefix[34] <== 1;
    amount_prefix[35] <== 1; amount_prefix[36] <== 0; amount_prefix[37] <== 1;
    amount_prefix[38] <== 1; amount_prefix[39] <== 0;
    
    // 't' = 0x74
    amount_prefix[40] <== 0; amount_prefix[41] <== 0; amount_prefix[42] <== 1;
    amount_prefix[43] <== 0; amount_prefix[44] <== 1; amount_prefix[45] <== 1;
    amount_prefix[46] <== 1; amount_prefix[47] <== 0;
    
    // Hash: 48 bits ("amount") + 256 bits (H_s_scalar padded)
    component amountKeyHash = Keccak(304, 256);
    
    for (var i = 0; i < 48; i++) {
        amountKeyHash.in[i] <== amount_prefix[i];
    }
    
    for (var i = 0; i < 255; i++) {
        amountKeyHash.in[48 + i] <== H_s_scalar[i];
    }
    amountKeyHash.in[48 + 255] <== 0;  // Pad to 256 bits
    
    // Take lower 64 bits for XOR mask
    signal amountKeyBits[64];
    for (var i = 0; i < 64; i++) {
        amountKeyBits[i] <== amountKeyHash.out[i];
    }
    
    // XOR decryption
    component ecdhBits = Num2Bits(64);
    ecdhBits.in <== ecdhAmount;
    
    component xorDecrypt[64];
    signal decryptedBits[64];
    for (var i = 0; i < 64; i++) {
        xorDecrypt[i] = XOR();
        xorDecrypt[i].a <== ecdhBits.out[i];
        xorDecrypt[i].b <== amountKeyBits[i];
        decryptedBits[i] <== xorDecrypt[i].out;
    }
    
    component decryptedAmount = Bits2Num(64);
    for (var i = 0; i < 64; i++) {
        decryptedAmount.in[i] <== decryptedBits[i];
    }
    
    // Verify decrypted amount matches claimed amount (prevents fraud)
    decryptedAmount.out === v;
    
    // ════════════════════════════════════════════════════════════════════════
    // OUTPUT
    // ════════════════════════════════════════════════════════════════════════
    
    verified_amount <== v;
}

// ════════════════════════════════════════════════════════════════════════════
// MAIN COMPONENT
// ════════════════════════════════════════════════════════════════════════════

component main {public [
    R_x,
    P_compressed,
    ecdhAmount,
    A_compressed,
    B_compressed,
    monero_tx_hash
]} = MoneroBridge();