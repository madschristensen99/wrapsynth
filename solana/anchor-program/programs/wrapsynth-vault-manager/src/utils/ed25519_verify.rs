/// Ed25519 secret verification — port of Ed25519.sol's scalarMultBase logic.
///
/// The EVM contract computes:
///   (px, py) = scalarMultBase(secret)   [affine coords, projective → affine via z-inversion]
///   commitment = keccak256(abi.encodePacked(uint256(px), uint256(py)))
///
/// `px` and `py` in the EVM library are in the field GF(2^255-19), encoded as Solidity
/// uint256 (big-endian). The Ed25519 library in Solidity works in **big-endian** because
/// it directly uses the `uint` type — so the uint256 representations ARE big-endian words
/// of the little-endian field elements.
///
/// In practice: Ed25519.sol's uint arithmetic stores field elements in standard Solidity
/// uint256 (big-endian), which corresponds to byte-reversing the little-endian dalek bytes.
///
/// Affine coordinates:
///   - Y: extracted directly from CompressedEdwardsY (bytes 0-31, LE, with sign bit cleared)
///   - X: recovered by decompressing CompressedEdwardsY → EdwardsPoint, then re-extracting
///        via the compress trick: negate Y sign → recover X from curve equation.
///
/// Since curve25519-dalek 4.x keeps X/Y as pub(crate) FieldElements, we recover X by:
///   1. Compress point → CompressedEdwardsY (bytes = Y LE, bit255 = X-sign)
///   2. Clear sign bit → Y bytes
///   3. Decompress again with sign=0 to get X-positive → compress X side via field identity.
///
/// Simpler: use the `AffineCoordinates` trait introduced in dalek 4.1.
/// `EdwardsPoint` implements `AffineCoordinates` with `.x()` and `.y()` returning `[u8;32]` LE.

use sha3::{Digest, Keccak256};
use curve25519_dalek::{
    constants::ED25519_BASEPOINT_POINT,
    scalar::Scalar,
    edwards::EdwardsPoint,
};

/// Compute keccak256(px_be || py_be) after scalar multiplication on Ed25519 basepoint.
/// Mirrors EVM: `bytes32(keccak256(abi.encodePacked(uint256(px), uint256(py))))`
/// where px, py are affine coordinates stored as big-endian uint256 in Solidity.
pub fn compute_commitment(secret: &[u8; 32]) -> [u8; 32] {
    let scalar = Scalar::from_bytes_mod_order(*secret);
    let point: EdwardsPoint = ED25519_BASEPOINT_POINT * scalar;

    // Compress → 32 bytes: Y in little-endian, bit 255 = X sign bit
    let compressed = point.compress();
    let compressed_bytes = compressed.as_bytes();

    // commitment = keccak256(compressed_bytes) where compressed_bytes is the
    // 32-byte CompressedEdwardsY (Y LE with X-sign in bit 255).
    // The LP server MUST generate commitments using this same scheme.

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
