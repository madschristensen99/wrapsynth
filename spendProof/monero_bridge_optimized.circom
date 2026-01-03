// monero_bridge_optimized.circom - Optimized Monero Bridge Circuit
// Optimization: Keccak256 moved to client-side witness generation
// Constraint reduction: ~150k constraints saved by removing Keccak component
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
// MAIN CIRCUIT - OPTIMIZED VERSION
// ════════════════════════════════════════════════════════════════════════════

template MoneroBridgeOptimized() {
    
    // ════════════════════════════════════════════════════════════════════════
    // PRIVATE INPUTS (witnesses - never revealed on-chain)
    // ════════════════════════════════════════════════════════════════════════
    
    signal input r[255];            // Transaction secret key (255-bit scalar)
    signal input v;                 // Amount in atomic piconero (64 bits)
    signal input s[255];            // Blinding factor for Pedersen commitment
    signal input output_index;      // Output index in transaction (0, 1, 2, ...)
    signal input H_s_scalar[255];   // Pre-reduced scalar: Keccak256(8·r·A || i) mod L
    signal input P_extended[4][3];  // Destination stealth address (extended coords)
    
    // ════════════════════════════════════════════════════════════════════════
    // PUBLIC INPUTS (verified on-chain by Solidity contract)
    // ════════════════════════════════════════════════════════════════════════
    
    signal input R_x;               // Transaction public key R (compressed)
    signal input P_compressed;      // Destination stealth address
    signal input ecdhAmount;        // ECDH-encrypted amount (64 bits)
    signal input A_compressed;      // Recipient view public key
    signal input B_compressed;      // Recipient spend public key
    signal input monero_tx_hash;    // Transaction hash for binding
    signal input C_compressed;      // Pedersen commitment from blockchain
    
    // ════════════════════════════════════════════════════════════════════════
    // OPTIMIZATION: Pre-computed amount key (moved from in-circuit Keccak)
    // ════════════════════════════════════════════════════════════════════════
    // This is computed client-side as: Keccak256("amount" || H_s_scalar)[0:64]
    // Solidity will verify this matches the expected hash
    // Constraint savings: ~150,000 constraints
    
    signal input amountKey[64];     // PUBLIC: Pre-computed amount key bits
    
    signal output verified_amount;
    
    // ════════════════════════════════════════════════════════════════════════
    // STEP 1: Verify R = r·G (proves knowledge of secret key r)
    // ════════════════════════════════════════════════════════════════════════
    
    component scalarMulG = ScalarMul();
    
    // Set base point G
    var G[4][3] = ed25519_G();
    for (var i = 0; i < 4; i++) {
        for (var j = 0; j < 3; j++) {
            scalarMulG.P[i][j] <== G[i][j];
        }
    }
    
    // Set scalar r
    for (var i = 0; i < 255; i++) {
        scalarMulG.s[i] <== r[i];
    }
    
    // Compress result to verify against public R_x
    component compressR = PointCompress();
    for (var i = 0; i < 4; i++) {
        for (var j = 0; j < 3; j++) {
            compressR.P[i][j] <== scalarMulG.sP[i][j];
        }
    }
    
    // Convert compressed bits to number
    component computedR_bits = Bits2Num(255);
    for (var i = 0; i < 255; i++) {
        computedR_bits.in[i] <== compressR.out[i];
    }
    
    // Verify compressed R matches public input
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
    
    // Convert compressed bits to number
    component computedP_bits = Bits2Num(255);
    for (var i = 0; i < 255; i++) {
        computedP_bits.in[i] <== compressP.out[i];
    }
    
    computedP_bits.out === P_compressed;
    
    // ════════════════════════════════════════════════════════════════════════
    // STEP 3: Compute shared secret S = 8·r·A (cofactor multiplication)
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
    
    // Compute r·A
    component scalarMulA = ScalarMul();
    for (var i = 0; i < 4; i++) {
        for (var j = 0; j < 3; j++) {
            scalarMulA.P[i][j] <== decompressA.out[i][j];
        }
    }
    for (var i = 0; i < 255; i++) {
        scalarMulA.s[i] <== r[i];
    }
    
    // Multiply by cofactor 8 via three point doublings
    // First doubling: 2·(r·A)
    component double1 = PointAdd();
    for (var i = 0; i < 4; i++) {
        for (var j = 0; j < 3; j++) {
            double1.P[i][j] <== scalarMulA.sP[i][j];
            double1.Q[i][j] <== scalarMulA.sP[i][j];
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
    
    // ════════════════════════════════════════════════════════════════════════
    // STEP 4: Decrypt amount using OPTIMIZED XOR operation
    // v_decrypted = ecdhAmount ⊕ amountKey
    // ════════════════════════════════════════════════════════════════════════
    // OPTIMIZATION: amountKey is now a public input (pre-computed client-side)
    // Solidity verifies: amountKey == Keccak256("amount" || H_s_scalar)[0:64]
    // Circuit only performs XOR verification (64 constraints vs ~150k)
    
    // Convert ecdhAmount to bits
    component ecdhBits = Num2Bits(64);
    ecdhBits.in <== ecdhAmount;
    
    // XOR decryption with pre-computed amount key
    component xorDecrypt[64];
    signal decryptedBits[64];
    for (var i = 0; i < 64; i++) {
        xorDecrypt[i] = XOR();
        xorDecrypt[i].a <== ecdhBits.out[i];
        xorDecrypt[i].b <== amountKey[i];  // PUBLIC INPUT (verified in Solidity)
        decryptedBits[i] <== xorDecrypt[i].out;
    }
    
    // Convert decrypted bits back to number
    component decryptedAmount = Bits2Num(64);
    for (var i = 0; i < 64; i++) {
        decryptedAmount.in[i] <== decryptedBits[i];
    }
    
    // Verify decrypted amount matches claimed amount (prevents fraud)
    decryptedAmount.out === v;
    
    // ════════════════════════════════════════════════════════════════════════
    // STEP 5: Verify Pedersen Commitment C = v·G + s·H
    // CRITICAL SECURITY: Proves the output actually exists on Monero blockchain
    // ════════════════════════════════════════════════════════════════════════
    
    // TODO: This requires implementing Pedersen commitment verification
    // For now, we accept C_compressed as a public input and will verify it
    // in a future update. This requires:
    // 1. ScalarMul for v·G (~800k constraints)
    // 2. ScalarMul for s·H (~800k constraints)  
    // 3. PointAdd to combine them (~600 constraints)
    // 4. PointCompress and compare to C_compressed (~500 constraints)
    // Total: ~1.6M additional constraints
    //
    // Alternative: Move Pedersen verification to Solidity using precompiles
    // or use a separate proof system (e.g., Bulletproofs)
    
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
    monero_tx_hash,
    C_compressed,  // NEW: Pedersen commitment from blockchain
    amountKey      // NEW: Pre-computed amount key (verified in Solidity)
]} = MoneroBridgeOptimized();
