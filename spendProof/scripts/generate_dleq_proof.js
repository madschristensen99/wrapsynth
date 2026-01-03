#!/usr/bin/env node

/**
 * generate_dleq_proof.js - DLEQ Proof Generation for Monero Bridge
 * 
 * Generates discrete logarithm equality proofs for Ed25519 operations
 * Proves: log_G(R) = log_A(S/8) = r (without revealing r)
 */

const ed = require('@noble/ed25519');
const { keccak256 } = require('js-sha3');
const crypto = require('crypto');

// Ed25519 curve order (2^252 + 27742317777372353535851937790883648493)
const L = BigInt('7237005577332262213973186563042994240857116359379907606001950938285454250989');

/**
 * Generate DLEQ proof: Prove log_G(R) = log_A(rA) = r
 * 
 * @param r - Secret scalar (BigInt)
 * @param G - Base point (Point)
 * @param A - View public key (Point)
 * @param R - r·G (Point)
 * @param rA - r·A (Point)
 * @returns DLEQ proof {c, s, K1, K2}
 */
function generateDLEQProof(r, G, A, R, rA) {
    // 1. Generate random nonce k
    const k = crypto.randomBytes(32);
    const k_scalar = BigInt('0x' + k.toString('hex')) % L;
    
    // 2. Compute commitments
    const K1 = ed.Point.BASE.multiply(k_scalar);  // k·G
    const K2 = A.multiply(k_scalar);  // k·A
    
    // 3. Compute challenge using Fiat-Shamir
    const challengeInput = Buffer.concat([
        Buffer.from(G.toHex()),
        Buffer.from(A.toHex()),
        Buffer.from(R.toHex()),
        Buffer.from(rA.toHex()),
        Buffer.from(K1.toHex()),
        Buffer.from(K2.toHex())
    ]);
    
    const challengeHash = keccak256(challengeInput);
    const c = BigInt('0x' + challengeHash) % L;
    
    // 4. Compute response: s = k + c·r (mod L)
    const r_bigint = BigInt('0x' + Buffer.from(r).toString('hex')) % L;
    const s = (k_scalar + c * r_bigint) % L;
    
    return {
        c: c.toString(),
        s: s.toString(),
        K1: {
            x: K1.x.toString(),
            y: K1.y.toString()
        },
        K2: {
            x: K2.x.toString(),
            y: K2.y.toString()
        }
    };
}

/**
 * Verify DLEQ proof
 * 
 * @param proof - DLEQ proof {c, s, K1, K2}
 * @param G - Base point
 * @param A - View public key
 * @param R - r·G
 * @param rA - r·A
 * @returns true if proof is valid
 */
function verifyDLEQProof(proof, G, A, R, rA) {
    const c = BigInt(proof.c);
    const s = BigInt(proof.s);
    
    // Reconstruct K1 and K2 from proof
    const K1 = ed.Point.fromAffine({
        x: BigInt(proof.K1.x),
        y: BigInt(proof.K1.y)
    });
    
    const K2 = ed.Point.fromAffine({
        x: BigInt(proof.K2.x),
        y: BigInt(proof.K2.y)
    });
    
    // Verify: s·G = K1 + c·R
    const sG = ed.Point.BASE.multiply(s);
    const cR = R.multiply(c);
    const lhs1 = sG;
    const rhs1 = K1.add(cR);
    
    // Verify: s·A = K2 + c·rA
    const sA = A.multiply(s);
    const c_rA = rA.multiply(c);
    const lhs2 = sA;
    const rhs2 = K2.add(c_rA);
    
    // Verify challenge
    const challengeInput = Buffer.concat([
        Buffer.from(G.toHex()),
        Buffer.from(A.toHex()),
        Buffer.from(R.toHex()),
        Buffer.from(rA.toHex()),
        Buffer.from(K1.toHex()),
        Buffer.from(K2.toHex())
    ]);
    
    const challengeHash = keccak256(challengeInput);
    const c_check = BigInt('0x' + challengeHash) % L;
    
    return lhs1.equals(rhs1) && lhs2.equals(rhs2) && c === c_check;
}

/**
 * Compute all Ed25519 operations for Monero bridge
 * 
 * @param r - Transaction secret key (hex string)
 * @param A_compressed - View public key (hex string)
 * @param B_compressed - Spend public key (hex string)
 * @param H_s - Shared secret scalar (hex string)
 * @returns Ed25519 points and DLEQ proof
 */
async function computeEd25519Operations(r, A_compressed, B_compressed, H_s) {
    console.log('\n🔐 Computing Ed25519 Operations (Native - FAST)\n');
    
    // Parse inputs
    const r_bytes = Buffer.from(r.replace(/^0x/, ''), 'hex');
    const r_scalar = BigInt('0x' + r) % L;
    
    let A, B;
    try {
        A = await ed.Point.fromHex(A_compressed.replace(/^0x/, ''));
    } catch(e) {
        throw new Error(`Failed to decompress A (view key): ${e.message}. A_compressed=${A_compressed.slice(0, 32)}...`);
    }
    
    try {
        B = await ed.Point.fromHex(B_compressed.replace(/^0x/, ''));
    } catch(e) {
        throw new Error(`Failed to decompress B (spend key): ${e.message}. B_compressed=${B_compressed.slice(0, 32)}...`);
    }
    
    const G = ed.Point.BASE;
    
    // 1. Compute R = r·G
    console.log('   1. Computing R = r·G...');
    const R = G.multiply(r_scalar);
    const R_compressed = Buffer.from(R.toHex()).toString('hex');
    console.log(`      ✅ R = ${R_compressed.slice(0, 16)}...`);
    
    // 2. Compute r·A
    console.log('   2. Computing r·A...');
    const rA = A.multiply(r_scalar);
    console.log(`      ✅ r·A computed`);
    
    // 3. Compute S = 8·(r·A) (cofactor multiplication)
    console.log('   3. Computing S = 8·(r·A)...');
    const S = rA.multiply(8n);
    const S_compressed = Buffer.from(S.toHex()).toString('hex');
    console.log(`      ✅ S = ${S_compressed.slice(0, 16)}...`);
    
    // 4. Compute P = H_s·G + B (stealth address)
    console.log('   4. Computing P = H_s·G + B...');
    const H_s_scalar = BigInt('0x' + H_s.replace(/^0x/, '')) % L;
    const H_s_G = G.multiply(H_s_scalar);
    const P = H_s_G.add(B);
    const P_compressed = Buffer.from(P.toHex()).toString('hex');
    console.log(`      ✅ P = ${P_compressed.slice(0, 16)}...`);
    
    // 5. Generate DLEQ proof
    console.log('   5. Generating DLEQ proof...');
    const dleqProof = generateDLEQProof(r_bytes, G, A, R, rA);
    console.log(`      ✅ DLEQ proof generated`);
    
    // 6. Verify DLEQ proof
    console.log('   6. Verifying DLEQ proof...');
    const isValid = verifyDLEQProof(dleqProof, G, A, R, rA);
    console.log(`      ${isValid ? '✅' : '❌'} DLEQ proof ${isValid ? 'valid' : 'INVALID'}`);
    
    return {
        R_x: '0x' + R_compressed,
        S_x: '0x' + S_compressed,
        P_compressed: '0x' + P_compressed,
        dleqProof,
        ed25519Proof: {
            G: {
                x: G.x.toString(),
                y: G.y.toString()
            },
            A: {
                x: A.x.toString(),
                y: A.y.toString()
            },
            B: {
                x: B.x.toString(),
                y: B.y.toString()
            },
            H_s: H_s_scalar.toString()
        }
    };
}

module.exports = {
    generateDLEQProof,
    verifyDLEQProof,
    computeEd25519Operations
};
