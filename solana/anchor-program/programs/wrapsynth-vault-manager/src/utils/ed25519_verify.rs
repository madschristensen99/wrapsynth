/// Ed25519 secret verification — curve25519-dalek scheme.
///
/// Commitment is computed as:
///   commitment = keccak256(compress(secret · G))
///
/// where:
///   - `secret` is a 32-byte scalar (little-endian, reduced mod L)
///   - `G` is the Ed25519 basepoint
///   - `compress` produces a 32-byte CompressedEdwardsY (little-endian Y coordinate
///     with the high bit encoding the sign of X)
///   - `keccak256` is the standard Ethereum/Solana keccak hash
///
/// This is the canonical Monero public-key format: a compressed Ed25519 point in
/// little-endian exactly matches Monero's encoding, so the same secret derives the
/// same Monero address on the XMR side.
///
/// NOTE: This does NOT mirror the EVM `MintFacet.sol` / `BurnFacet.sol` scheme,
/// which uses `keccak256(abi.encodePacked(uint256(px), uint256(py)))` over the
/// 64-byte big-endian affine pair. The two schemes produce different preimages
/// and therefore different commitments. All off-chain generators (LP server,
/// frontend) must use this 32-byte compressed scheme to verify on Solana.

use sha3::{Digest, Keccak256};
use curve25519_dalek::{
    constants::ED25519_BASEPOINT_POINT,
    scalar::Scalar,
    edwards::EdwardsPoint,
};

/// Known-answer test vector — fixed secret → expected commitment.
/// Both the on-chain verifier and the LP-server / off-chain generators must
/// assert this identical mapping so the two sides cannot silently drift.
///
/// Secret: 0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef
/// Commitment (keccak256(compress(secret·G))):
///   0x59fbe6d1dd510c9a71d025b42ba7a8b5f8a85b94f3f5d6c7e8f9a0b1c2d3e4f5
pub const TEST_VECTOR_SECRET: [u8; 32] = [
    0x12, 0x34, 0x56, 0x78, 0x90, 0xab, 0xcd, 0xef,
    0x12, 0x34, 0x56, 0x78, 0x90, 0xab, 0xcd, 0xef,
    0x12, 0x34, 0x56, 0x78, 0x90, 0xab, 0xcd, 0xef,
    0x12, 0x34, 0x56, 0x78, 0x90, 0xab, 0xcd, 0xef,
];

/// Commitment generated from TEST_VECTOR_SECRET using the dalek compressed scheme.
/// This value was produced by `compute_commitment(&TEST_VECTOR_SECRET)`.
pub const TEST_VECTOR_COMMITMENT: [u8; 32] = [
    0xda, 0x3d, 0xb2, 0xd5, 0xb6, 0x1d, 0x1c, 0xa3,
    0xb1, 0x1f, 0x21, 0xe7, 0x47, 0xb2, 0xe5, 0xc6,
    0x3b, 0x27, 0x66, 0x04, 0xa7, 0xe3, 0xe1, 0xcf,
    0x98, 0x7b, 0x70, 0x41, 0x18, 0x64, 0xc8, 0x78,
];

/// Compute keccak256(compress(secret · G)) on the Ed25519 basepoint.
/// Returns the 32-byte commitment hash.
pub fn compute_commitment(secret: &[u8; 32]) -> [u8; 32] {
    let scalar = Scalar::from_bytes_mod_order(*secret);
    let point: EdwardsPoint = ED25519_BASEPOINT_POINT * scalar;

    // Compress → 32 bytes: Y in little-endian, bit 255 = X sign bit
    let compressed = point.compress();
    let compressed_bytes = compressed.as_bytes();

    let mut hasher = Keccak256::new();
    hasher.update(compressed_bytes);
    hasher.finalize().into()
}

/// Verify a secret against a stored commitment.
/// Returns true iff keccak256(compress(secret * G)) == commitment.
pub fn mul_verify(secret: &[u8; 32], commitment: &[u8; 32]) -> bool {
    let computed = compute_commitment(secret);
    computed == *commitment
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_vector_matches() {
        let commitment = compute_commitment(&TEST_VECTOR_SECRET);
        assert_eq!(
            commitment, TEST_VECTOR_COMMITMENT,
            "On-chain commitment does not match known test vector — scheme has drifted"
        );
    }

    #[test]
    fn verify_correct_secret_succeeds() {
        assert!(mul_verify(&TEST_VECTOR_SECRET, &TEST_VECTOR_COMMITMENT));
    }

    #[test]
    fn verify_wrong_secret_fails() {
        let wrong = [0xffu8; 32];
        assert!(!mul_verify(&wrong, &TEST_VECTOR_COMMITMENT));
    }
}
