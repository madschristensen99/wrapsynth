// Seed Management for WrapSynth
// Generates Ed25519 keys from BIP-39 seed phrases (Monero-compatible)

import { keccak256, toHex, hexToBytes, bytesToBigInt } from 'https://esm.sh/viem@2.7.0';
import { Point } from 'https://esm.sh/noble-ed25519@2.0.0';
import { mnemonicToAccount, english, generateMnemonic } from 'https://esm.sh/viem@2.7.0/accounts';

// Ed25519 group order (same as Monero)
const ED25519_L = 2n**252n + 27742317777372353535851937790883648493n;

// HD derivation paths (following MoneroSwap convention)
const SPEND_KEY_PATH = "m/44'/128'/0'/0/0";  // Monero coin type 128
const MESSAGE_KEY_PATH = "m/44'/128'/0'/1/0";

/**
 * Generate a new BIP-39 seed phrase
 * @param {number} wordCount - 12 or 24 words (default: 12)
 * @returns {string} Seed phrase
 */
export function generateSeedPhrase(wordCount = 12) {
    if (wordCount !== 12 && wordCount !== 24) {
        throw new Error('Word count must be 12 or 24');
    }
    
    // viem's generateMnemonic defaults to 12 words
    // For 24 words, we'd need to use a different entropy size
    const seed = generateMnemonic(english);
    return seed;
}

/**
 * Validate a seed phrase
 * @param {string} seedPhrase - Seed phrase to validate
 * @returns {boolean} True if valid
 */
export function validateSeedPhrase(seedPhrase) {
    try {
        const trimmed = seedPhrase.trim();
        const words = trimmed.split(/\s+/);
        
        // Check word count
        if (words.length !== 12 && words.length !== 24) {
            return false;
        }
        
        // Try to derive keys - will throw if invalid
        mnemonicToAccount(trimmed, { path: SPEND_KEY_PATH });
        return true;
    } catch (error) {
        return false;
    }
}

/**
 * Generate Ed25519 keys from seed phrase
 * This follows Monero's key derivation scheme
 * 
 * @param {string} seedPhrase - BIP-39 seed phrase
 * @returns {Object} Keys object with private and public keys
 */
export function generateKeysFromSeed(seedPhrase) {
    const trimmed = seedPhrase.trim();
    
    // Derive private spend key from HD path
    const privateSpendKey = mnemonicToAccount(trimmed, { path: SPEND_KEY_PATH })
        .getHdKey().privKey % ED25519_L;
    
    // Derive private message key from HD path
    const privateMessageKey = mnemonicToAccount(trimmed, { path: MESSAGE_KEY_PATH })
        .getHdKey().privKey % ED25519_L;
    
    // Derive private view key from private spend key (Monero style)
    const privateSpendKeyHex = '0x' + privateSpendKey.toString(16).padStart(64, '0');
    let bytes = hexToBytes(privateSpendKeyHex);
    bytes.reverse(); // Little endian
    const privateViewKey = bytesToBigInt(hexToBytes(keccak256(bytes)).reverse()) % ED25519_L;
    
    // Generate public keys via Ed25519 scalar multiplication
    const publicSpendKey = Point.BASE.multiply(privateSpendKey, true);
    const publicViewKey = Point.BASE.multiply(privateViewKey, true);
    const publicMessageKey = Point.BASE.multiply(privateMessageKey, true);
    
    return {
        privateSpendKey,
        publicSpendKey: bytesToBigInt(publicSpendKey.toRawBytes()),
        privateViewKey,
        publicViewKey: bytesToBigInt(publicViewKey.toRawBytes()),
        privateMessageKey,
        publicMessageKey: bytesToBigInt(publicMessageKey.toRawBytes())
    };
}

/**
 * Generate commitment from secret for contract verification
 * This is what gets stored on-chain
 * 
 * @param {bigint} secret - Private key (spend key)
 * @returns {string} Commitment hash (bytes32)
 */
export function generateCommitment(secret) {
    // Reduce secret modulo group order
    const secretReduced = secret % ED25519_L;
    
    // Generate Ed25519 public key: P = secret * G
    const publicKeyPoint = Point.BASE.multiply(secretReduced);
    
    // Get raw bytes of the public key point
    const publicKeyBytes = publicKeyPoint.toRawBytes();
    const publicKeyHex = toHex(publicKeyBytes);
    
    // Extract x and y coordinates (32 bytes each)
    const px = publicKeyHex.slice(0, 66); // First 32 bytes
    const py = '0x' + publicKeyHex.slice(66); // Next 32 bytes
    
    // Generate commitment as keccak256(abi.encodePacked(px, py))
    // This matches the VaultManager contract verification
    const commitment = keccak256(px + py.slice(2));
    
    return commitment;
}

/**
 * Generate Monero address from public keys
 * Note: This is a simplified version - full Monero address generation
 * requires proper base58 encoding with checksum
 * 
 * @param {bigint} publicSpendKey - Public spend key
 * @param {bigint} publicViewKey - Public view key
 * @returns {string} Monero address (placeholder for now)
 */
export function generateMoneroAddress(publicSpendKey, publicViewKey) {
    // TODO: Implement full Monero address generation
    // For now, return a placeholder
    const spendHex = publicSpendKey.toString(16).padStart(64, '0');
    const viewHex = publicViewKey.toString(16).padStart(64, '0');
    
    // This is NOT a real Monero address - just a placeholder
    return `XMR_${spendHex.slice(0, 8)}...${viewHex.slice(0, 8)}`;
}

/**
 * Create a complete key set for a mint/burn operation
 * 
 * @param {string} seedPhrase - BIP-39 seed phrase
 * @returns {Object} Complete key set with commitment
 */
export function createKeySet(seedPhrase) {
    const keys = generateKeysFromSeed(seedPhrase);
    const commitment = generateCommitment(keys.privateSpendKey);
    const moneroAddress = generateMoneroAddress(keys.publicSpendKey, keys.publicViewKey);
    
    return {
        ...keys,
        commitment,
        moneroAddress,
        // For contract interaction
        secret: '0x' + keys.privateSpendKey.toString(16).padStart(64, '0')
    };
}
