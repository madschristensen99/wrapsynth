// secrets.js — Ed25519 secret/commitment conventions for the WrapSynth Solana
// program. SINGLE SOURCE OF TRUTH for the wire format.
//
// On-chain verification (utils/ed25519_verify.rs):
//   commitment = keccak256( compress(secret · G) )
//   where compress() is the canonical 32-byte CompressedEdwardsY — the standard
//   Monero public-key encoding. This is DIFFERENT from the EVM contract, which
//   used keccak256(abi.encodePacked(px, py)) — do not reuse EVM-side helpers.
//
// The scalar must be canonical (< group order L): sol_curve_multiscalar_mul
// rejects non-canonical input, so makeSecret() masks the top byte.

import { keccak_256 } from '@noble/hashes/sha3';
import { sha512 } from '@noble/hashes/sha512.js';
import { randomBytes } from '@noble/hashes/utils.js';
import * as ed from '@noble/ed25519';

if (!ed.etc.sha512Sync) {
  ed.etc.sha512Sync = (...m) => sha512(ed.etc.concatBytes(...m));
}

export const ED25519_L =
  2n ** 252n + 27742317777372353535851937790883648493n;

/** Read a 32-byte secret as a little-endian scalar, reduced mod L. */
export function leScalar(secret) {
  const buf = Buffer.isBuffer(secret) ? secret : Buffer.from(secret);
  let s = 0n;
  for (let i = 0; i < 32; i++) s |= BigInt(buf[i]) << BigInt(i * 8);
  return s % ED25519_L;
}

/** compress(secret·G) — 32-byte compressed Ed25519 point. */
export function computePublicKey(secret) {
  return Buffer.from(
    ed.ExtendedPoint.BASE.multiply(leScalar(secret)).toRawBytes()
  );
}

/** keccak256(compress(secret·G)) — the on-chain commitment. */
export function computeCommitment(secret) {
  return Buffer.from(keccak_256(computePublicKey(secret)));
}

/** Generate a canonical-scalar secret + its commitment and public key. */
export function makeSecret() {
  // noble randomBytes returns Uint8Array — wrap in Buffer so .toString('hex')
  // works (Uint8Array.toString ignores the radix and produces CSV decimals,
  // which corrupted a persisted lpSecret in lp-burn-secrets.json).
  const secret = Buffer.from(randomBytes(32));
  // Canonical scalar — REQUIRED or the on-chain syscall rejects it.
  secret[31] &= 0x0f;
  return {
    secret,
    commitment: computeCommitment(secret),
    pubKey: computePublicKey(secret),
  };
}
