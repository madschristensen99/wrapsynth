/**
 * Known-answer test for Ed25519 commitment generation.
 * Asserts that JS computeSecretHash reproduces the on-chain test vector.
 * Run: node test-ed25519-vector.js
 *
 * This MUST match wrapsynth-vault-manager::utils::ed25519_verify
 * (TEST_VECTOR_SECRET / TEST_VECTOR_COMMITMENT).
 */

import { createHash } from 'crypto';
import * as ethers from 'ethers';

// ─── Shared test vector (same bytes as Rust TEST_VECTOR_SECRET) ─────────────
const TEST_VECTOR_SECRET = Buffer.from([
  0x12, 0x34, 0x56, 0x78, 0x90, 0xab, 0xcd, 0xef,
  0x12, 0x34, 0x56, 0x78, 0x90, 0xab, 0xcd, 0xef,
  0x12, 0x34, 0x56, 0x78, 0x90, 0xab, 0xcd, 0xef,
  0x12, 0x34, 0x56, 0x78, 0x90, 0xab, 0xcd, 0xef,
]);

// On-chain commitment from wrapsynth-vault-manager::utils::ed25519_verify
const TEST_VECTOR_COMMITMENT = '0xda3db2d5b61d1ca3b11f21e747b2e5c63b276604a7e3e1cf987b70411864c878';

const ED25519_L = 2n ** 252n + 27742317777372353535851937790883648493n;

/**
 * Compute secretHash from a secret scalar.
 * Matches WrapSynth on-chain verifier exactly:
 *   secretHash = keccak256(compress(secret · G))
 */
async function computeSecretHash(secretBytes) {
  const ed = await import('@noble/ed25519');

  if (!ed.etc.sha512Sync) {
    ed.etc.sha512Sync = (...m) => createHash('sha512').update(Buffer.concat(m)).digest();
  }

  // Read secret as little-endian to match dalek's Scalar::from_bytes_mod_order
  const secretBigInt = BigInt('0x' + Buffer.from(secretBytes).reverse().toString('hex'));
  const secretReduced = secretBigInt % ED25519_L;

  const publicKeyPoint = ed.ExtendedPoint.BASE.multiply(secretReduced);
  const publicKeyBytes = publicKeyPoint.toRawBytes(); // 32-byte compressed point

  const secretHash = ethers.utils.keccak256(publicKeyBytes); // hash the 32 bytes directly
  return { secretHash };
}

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
