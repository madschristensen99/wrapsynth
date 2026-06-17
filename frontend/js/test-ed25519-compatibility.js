// Test Ed25519 Compatibility Between Frontend and Contract
// This script verifies that the frontend generates commitments that match
// what the VaultManager contract expects

import { keccak256, toHex, hexToBytes } from 'https://esm.sh/viem@2.7.0';
import { Point } from 'https://esm.sh/noble-ed25519@2.0.0';

const ED25519_L = 2n**252n + 27742317777372353535851937790883648493n;

/**
 * Shared test vector — MUST match wrapsynth-vault-manager::utils::ed25519_verify.
 * If this diverges from the Rust test, the JS side cannot verify on-chain commitments.
 */
const TEST_VECTOR_SECRET_HEX = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef';
const TEST_VECTOR_COMMITMENT   = '0xda3db2d5b61d1ca3b11f21e747b2e5c63b276604a7e3e1cf987b70411864c878';

/**
 * Read a 32-byte secret as little-endian to match dalek's from_bytes_mod_order.
 */
function secretToScalar(secretHex) {
    const secretBytes = hexToBytes(secretHex);
    let scalar = 0n;
    for (let i = 0; i < 32; i++) {
        scalar |= BigInt(secretBytes[i]) << BigInt(i * 8);
    }
    return scalar % ED25519_L;
}

/**
 * Compute commitment from secret using the WrapSynth on-chain scheme:
 *   commitment = keccak256(compress(secret · G))
 * where compress yields a 32-byte little-endian CompressedEdwardsY.
 */
function computeCommitment(secretHex) {
    const secretReduced = secretToScalar(secretHex);
    const publicKeyPoint = Point.BASE.multiply(secretReduced);
    const publicKeyBytes = publicKeyPoint.toRawBytes(); // 32-byte compressed
    return keccak256(toHex(publicKeyBytes));
}

/**
 * Test that JS commitment generation matches the on-chain known-answer vector.
 * This is the Tier-1 guard against silent drift between JS and Rust.
 */
async function testKnownAnswerVector() {
    console.log('=== Known-Answer Vector Test ===\n');

    const commitment = computeCommitment(TEST_VECTOR_SECRET_HEX);
    console.log('Computed commitment:', commitment);
    console.log('Expected commitment: ', TEST_VECTOR_COMMITMENT);

    const matches = commitment.toLowerCase() === TEST_VECTOR_COMMITMENT.toLowerCase();
    if (matches) {
        console.log('\n[SUCCESS] JS commitment matches on-chain test vector');
    } else {
        console.log('\n[FAILED] JS commitment does NOT match on-chain test vector — scheme has drifted!');
        process.exit(1);
    }
    return matches;
}

/**
 * Test commitment generation and verification.
 */
async function testCommitmentGeneration() {
    console.log('\n=== Testing Ed25519 Commitment Generation ===\n');

    const testSecret = TEST_VECTOR_SECRET_HEX;
    console.log('Test Secret:', testSecret);

    const secretReduced = secretToScalar(testSecret);
    console.log('Secret (reduced mod L):', '0x' + secretReduced.toString(16));

    const publicKeyPoint = Point.BASE.multiply(secretReduced);
    const publicKeyBytes = publicKeyPoint.toRawBytes();
    console.log('Public Key (raw bytes):', toHex(publicKeyBytes));
    console.log('Public Key length:', publicKeyBytes.length, 'bytes');

    const commitment = computeCommitment(testSecret);
    console.log('\n=== RESULT ===');
    console.log('Commitment (keccak256(compress(secret·G))):', commitment);

    return { secret: testSecret, secretReduced: '0x' + secretReduced.toString(16), commitment };
}

/**
 * Test secret verification.
 */
async function testSecretVerification(secret, expectedCommitment) {
    console.log('\n=== Testing Secret Verification ===\n');
    console.log('Secret:', secret);
    console.log('Expected Commitment:', expectedCommitment);

    const computedCommitment = computeCommitment(secret);
    console.log('Computed Commitment:', computedCommitment);

    const matches = computedCommitment.toLowerCase() === expectedCommitment.toLowerCase();
    if (matches) {
        console.log('[SUCCESS] VERIFICATION SUCCESS: Secret matches commitment!');
    } else {
        console.log('[FAILED] VERIFICATION FAILED: Secret does not match commitment!');
    }
    return matches;
}

/**
 * Run all tests
 */
async function runTests() {
    try {
        // Tier-1 guard: known-answer vector must match on-chain Rust test
        await testKnownAnswerVector();

        // Test 1: Generate commitment
        const result = await testCommitmentGeneration();

        // Test 2: Verify the secret
        await testSecretVerification(result.secret, result.commitment);

        // Test 3: Verify with wrong secret (should fail)
        console.log('\n=== Testing with Wrong Secret (should fail) ===');
        const wrongSecret = '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
        await testSecretVerification(wrongSecret, result.commitment);

        console.log('\n=== All Tests Complete ===');
        console.log('✓ Frontend Ed25519 implementation is compatible with on-chain verifier');

    } catch (error) {
        console.error('Test failed:', error);
        process.exit(1);
    }
}

// Run tests if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
    runTests();
}

export { secretToScalar, computeCommitment, testKnownAnswerVector, testCommitmentGeneration, testSecretVerification, runTests };
