/// Real Ed25519/Curve25519 operations for Monero keys
/// This module provides production-grade cryptographic operations
/// that run OFF-CHAIN and can be verified in the MPC

use curve25519_dalek::{
    constants::ED25519_BASEPOINT_TABLE,
    edwards::CompressedEdwardsY,
    scalar::Scalar,
};
use ed25519_dalek::{SigningKey, VerifyingKey, Signature, Signer, Verifier};
use sha3::{Digest, Keccak256};
use rand_core::{RngCore, CryptoRng};

/// Monero private key (Ed25519 scalar)
#[derive(Clone, Debug)]
pub struct MoneroPrivateKey {
    scalar: Scalar,
}

impl MoneroPrivateKey {
    /// Generate a new random Monero private key
    pub fn generate<R: RngCore + CryptoRng>(rng: &mut R) -> Self {
        let mut bytes = [0u8; 32];
        rng.fill_bytes(&mut bytes);
        
        // Reduce to valid scalar
        let scalar = Scalar::from_bytes_mod_order(bytes);
        
        Self { scalar }
    }
    
    /// Create from seed using Keccak256
    pub fn from_seed(seed: &[u8]) -> Self {
        let mut hasher = Keccak256::new();
        hasher.update(seed);
        let hash = hasher.finalize();
        
        let mut bytes = [0u8; 32];
        bytes.copy_from_slice(&hash);
        
        let scalar = Scalar::from_bytes_mod_order(bytes);
        Self { scalar }
    }
    
    /// Get the raw bytes
    pub fn to_bytes(&self) -> [u8; 32] {
        self.scalar.to_bytes()
    }
    
    /// Create from bytes
    pub fn from_bytes(bytes: [u8; 32]) -> Option<Self> {
        let scalar = Scalar::from_canonical_bytes(bytes);
        if scalar.is_some().into() {
            Some(Self { scalar: scalar.unwrap() })
        } else {
            None
        }
    }
    
    /// Derive the public key using Ed25519 point multiplication
    pub fn derive_public_key(&self) -> MoneroPublicKey {
        // PubKey = PrivKey * G (base point)
        let point = &self.scalar * ED25519_BASEPOINT_TABLE;
        let compressed = point.compress();
        
        MoneroPublicKey {
            point: compressed,
        }
    }
}

/// Monero public key (Ed25519 point)
#[derive(Clone, Debug)]
pub struct MoneroPublicKey {
    point: CompressedEdwardsY,
}

impl MoneroPublicKey {
    /// Get the raw bytes
    pub fn to_bytes(&self) -> [u8; 32] {
        self.point.to_bytes()
    }
    
    /// Create from bytes
    pub fn from_bytes(bytes: [u8; 32]) -> Option<Self> {
        let point = CompressedEdwardsY::from_slice(&bytes).ok()?;
        
        // Verify it's a valid point
        point.decompress()?;
        
        Some(Self { point })
    }
    
    /// Verify this is a valid Ed25519 point
    pub fn is_valid(&self) -> bool {
        self.point.decompress().is_some()
    }
}

/// Key pair for Monero
#[derive(Clone, Debug)]
pub struct MoneroKeyPair {
    pub private_key: MoneroPrivateKey,
    pub public_key: MoneroPublicKey,
}

impl MoneroKeyPair {
    /// Generate a new random key pair
    pub fn generate<R: RngCore + CryptoRng>(rng: &mut R) -> Self {
        let private_key = MoneroPrivateKey::generate(rng);
        let public_key = private_key.derive_public_key();
        
        Self {
            private_key,
            public_key,
        }
    }
    
    /// Create from seed
    pub fn from_seed(seed: &[u8]) -> Self {
        let private_key = MoneroPrivateKey::from_seed(seed);
        let public_key = private_key.derive_public_key();
        
        Self {
            private_key,
            public_key,
        }
    }
}

/// Verify that a public key was correctly derived from a private key
pub fn verify_key_derivation(
    private_key_bytes: &[u8; 32],
    public_key_bytes: &[u8; 32],
) -> bool {
    let private_key = match MoneroPrivateKey::from_bytes(*private_key_bytes) {
        Some(k) => k,
        None => return false,
    };
    
    let derived_public = private_key.derive_public_key();
    let claimed_public = match MoneroPublicKey::from_bytes(*public_key_bytes) {
        Some(k) => k,
        None => return false,
    };
    
    derived_public.to_bytes() == claimed_public.to_bytes()
}

/// Sign a message with a Monero private key (for authentication)
pub fn sign_message(private_key: &MoneroPrivateKey, message: &[u8]) -> [u8; 64] {
    // Use Ed25519 signing
    let signing_key = SigningKey::from_bytes(&private_key.to_bytes());
    let signature = signing_key.sign(message);
    signature.to_bytes()
}

/// Verify a signature
pub fn verify_signature(
    public_key: &MoneroPublicKey,
    message: &[u8],
    signature: &[u8; 64],
) -> bool {
    let verifying_key = match VerifyingKey::from_bytes(&public_key.to_bytes()) {
        Ok(k) => k,
        Err(_) => return false,
    };
    
    let sig = Signature::from_bytes(signature);
    
    verifying_key.verify(message, &sig).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand::rngs::OsRng;
    
    #[test]
    fn test_key_generation() {
        let mut rng = OsRng;
        let keypair = MoneroKeyPair::generate(&mut rng);
        
        // Verify public key is valid
        assert!(keypair.public_key.is_valid());
        
        // Verify derivation
        assert!(verify_key_derivation(
            &keypair.private_key.to_bytes(),
            &keypair.public_key.to_bytes(),
        ));
    }
    
    #[test]
    fn test_deterministic_generation() {
        let seed = b"test_seed_123";
        
        let keypair1 = MoneroKeyPair::from_seed(seed);
        let keypair2 = MoneroKeyPair::from_seed(seed);
        
        // Same seed should produce same keys
        assert_eq!(
            keypair1.private_key.to_bytes(),
            keypair2.private_key.to_bytes()
        );
        assert_eq!(
            keypair1.public_key.to_bytes(),
            keypair2.public_key.to_bytes()
        );
    }
    
    #[test]
    fn test_signing() {
        let mut rng = OsRng;
        let keypair = MoneroKeyPair::generate(&mut rng);
        
        let message = b"Hello, Monero!";
        let signature = sign_message(&keypair.private_key, message);
        
        // Verify signature
        assert!(verify_signature(&keypair.public_key, message, &signature));
        
        // Wrong message should fail
        assert!(!verify_signature(&keypair.public_key, b"Wrong message", &signature));
    }
    
    #[test]
    fn test_serialization() {
        let mut rng = OsRng;
        let keypair = MoneroKeyPair::generate(&mut rng);
        
        // Serialize and deserialize
        let priv_bytes = keypair.private_key.to_bytes();
        let pub_bytes = keypair.public_key.to_bytes();
        
        let priv_key2 = MoneroPrivateKey::from_bytes(priv_bytes).unwrap();
        let pub_key2 = MoneroPublicKey::from_bytes(pub_bytes).unwrap();
        
        assert_eq!(priv_key2.to_bytes(), priv_bytes);
        assert_eq!(pub_key2.to_bytes(), pub_bytes);
    }
}
