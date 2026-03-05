use anchor_lang::prelude::*;
use k256::{
    elliptic_curve::sec1::ToEncodedPoint,
    ProjectivePoint, Scalar,
};
use sha2::{Digest, Sha256};

pub fn verify_secret_commitment(secret: &[u8; 32], commitment: &[u8; 32]) -> Result<bool> {
    use k256::elliptic_curve::scalar::FromUintUnchecked;
    use k256::U256;
    
    let secret_uint = U256::from_be_slice(secret);
    let scalar_secret = Scalar::from_uint_unchecked(secret_uint);
    
    let expected_point = (ProjectivePoint::GENERATOR * scalar_secret).to_affine();
    
    let encoded_point = expected_point.to_encoded_point(false);
    
    let mut hasher = Sha256::new();
    hasher.update(encoded_point.as_bytes());
    let point_hash = hasher.finalize();
    
    Ok(&point_hash[..] == commitment)
}

pub fn hash_secret(secret: &[u8; 32]) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(secret);
    let result = hasher.finalize();
    let mut hash = [0u8; 32];
    hash.copy_from_slice(&result);
    hash
}
