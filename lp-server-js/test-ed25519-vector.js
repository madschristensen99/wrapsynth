/**
 * Known-answer test for Ed25519 commitment generation.
 * Asserts that the SHARED production computeSecretHash reproduces the on-chain test vector.
 * Run: node test-ed25519-vector.js
 *
 * This MUST match wrapsynth-vault-manager::utils::ed25519_verify
 * (TEST_VECTOR_SECRET / TEST_VECTOR_COMMITMENT).
 */

import { computeSecretHash } from './commitment.js';

// ─── Shared test vector (same bytes as Rust TEST_VECTOR_SECRET) ─────────────
const TEST_VECTOR_SECRET = Buffer.from([
  0x12, 0x34, 0x56, 0x78, 0x90, 0xab, 0xcd, 0xef,
  0x12, 0x34, 0x56, 0x78, 0x90, 0xab, 0xcd, 0xef,
  0x12, 0x34, 0x56, 0x78, 0x90, 0xab, 0xcd, 0xef,
  0x12, 0x34, 0x56, 0x78, 0x90, 0xab, 0xcd, 0xef,
]);

// EVM commitment (keccak256 of abi.encodePacked(uint256(px), uint256(py)))
const TEST_VECTOR_COMMITMENT = '0xfd2d6da99e17ad48728ce28ae23b714f012712a29a9247217f9c72d429ad8f58';

(async () => {
  console.log('=== LP-node Ed25519 known-answer test ===\n');

  const { secretHash } = await computeSecretHash(TEST_VECTOR_SECRET);
  console.log('Computed commitment:', secretHash);
  console.log('Expected commitment: ', TEST_VECTOR_COMMITMENT);

  if (secretHash.toLowerCase() !== TEST_VECTOR_COMMITMENT.toLowerCase()) {
    console.error('\n[FAILED] JS commitment does NOT match on-chain test vector — scheme has drifted!');
    process.exit(1);
  }

  console.log('\n[SUCCESS] LP-node commitment matches on-chain test vector');
})();
