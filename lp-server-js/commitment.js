/**
 * Shared Ed25519 commitment generator for WrapSynth EVM LP server.
 *
 * Matches the EVM contract exactly:
 *   commitment = keccak256(abi.encodePacked(uint256(px), uint256(py)))
 *
 * where:
 *   - secret is read as a big-endian uint256 (matches Solidity)
 *   - G is the Ed25519 basepoint
 *   - (px, py) are the 32-byte big-endian affine coordinates of P = secret · G
 *   - keccak256 is the Ethereum Keccak-256 hash
 *
 * This is the single source of truth for the EVM side.
 * burnHandler.js, processPastBurns.js, and the test suite all import from here.
 */

import { keccak_256 } from '@noble/hashes/sha3';
import { createHash } from 'crypto';

// Ed25519 group order
const ED25519_L = 2n ** 252n + 27742317777372353535851937790883648493n;

/**
 * Compute the WrapSynth EVM commitment from a 32-byte secret.
 *
 * @param {Uint8Array|Buffer} secretBytes — 32-byte secret
 * @returns {Promise<{secretHash: string}>} hex-encoded commitment (0x-prefixed)
 */
export async function computeSecretHash(secretBytes) {
  const ed = await import('@noble/ed25519');

  // @noble/ed25519 needs a sync SHA-512 hasher registered
  if (!ed.etc.sha512Sync) {
    ed.etc.sha512Sync = (...m) => createHash('sha512').update(Buffer.concat(m)).digest();
  }

  // EVM: read secret as big-endian uint256 (matches Solidity)
  const secretBigInt = BigInt('0x' + Buffer.from(secretBytes).toString('hex'));
  const secretReduced = secretBigInt % ED25519_L;

  // P = secret · G
  const publicKeyPoint = ed.ExtendedPoint.BASE.multiply(secretReduced);
  const affine = publicKeyPoint.toAffine();

  // EVM: encode as two 32-byte big-endian uint256 values
  const pxHex = affine.x.toString(16).padStart(64, '0');
  const pyHex = affine.y.toString(16).padStart(64, '0');
  const packed = Buffer.from(pxHex + pyHex, 'hex');

  // keccak256 of the 64 bytes — same as Solidity abi.encodePacked(uint256, uint256)
  const hashBytes = keccak_256(packed);
  const secretHash = '0x' + Buffer.from(hashBytes).toString('hex');

  return { secretHash };
}
