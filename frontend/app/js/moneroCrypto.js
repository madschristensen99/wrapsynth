/**
 * Monero cryptography utilities for Farcaster atomic swaps
 * Implements Ed25519 point addition and Monero address derivation
 */

import { keccak256 as viemKeccak256, hexToBytes as viemHexToBytes } from 'https://esm.sh/viem@2.7.0';

// Using @noble/ed25519 for Ed25519 operations
// This is a lightweight, audited library for Ed25519 cryptography
// Install via: <script type="module"> import from CDN

/**
 * Add two Ed25519 points (P_a + P_b)
 * @param {Uint8Array} pointA - First point (32 bytes)
 * @param {Uint8Array} pointB - Second point (32 bytes)
 * @returns {Uint8Array} - Combined point (32 bytes)
 */
export async function addEd25519Points(pointA, pointB) {
    // Import noble/ed25519 dynamically
    const ed = await import('https://esm.sh/@noble/ed25519@2.0.0');
    
    // Decompress points from compressed Edwards Y coordinates
    const pA = ed.ExtendedPoint.fromHex(pointA);
    const pB = ed.ExtendedPoint.fromHex(pointB);
    
    // Add the points
    const combined = pA.add(pB);
    
    // Return compressed point
    return combined.toRawBytes();
}

/**
 * Derive Monero address from public spend and view keys
 * @param {Uint8Array} publicSpendKey - 32 bytes
 * @param {Uint8Array} publicViewKey - 32 bytes
 * @param {boolean} mainnet - true for mainnet, false for testnet
 * @returns {string} - Monero address
 */
export function deriveMoneroAddress(publicSpendKey, publicViewKey, mainnet = true) {
    // Monero address format:
    // [network_byte][public_spend_key][public_view_key][checksum]
    
    const networkByte = mainnet ? 0x12 : 0x35; // 18 for mainnet, 53 for testnet
    
    // Concatenate: network byte + spend key + view key
    const data = new Uint8Array(1 + 32 + 32);
    data[0] = networkByte;
    data.set(publicSpendKey, 1);
    data.set(publicViewKey, 33);
    
    // Compute checksum (first 4 bytes of Keccak-256 hash)
    const checksum = keccak256(data).slice(0, 4);
    
    // Concatenate data + checksum
    const addressBytes = new Uint8Array(data.length + checksum.length);
    addressBytes.set(data);
    addressBytes.set(checksum, data.length);
    
    // Encode to base58
    return base58Encode(addressBytes);
}

/**
 * Keccak-256 hash (used by Monero)
 * @param {Uint8Array} data
 * @returns {Uint8Array}
 */
function keccak256(data) {
    const hash = viemKeccak256(data);
    return viemHexToBytes(hash);
}

/**
 * Base58 encoding (Monero variant - block-based)
 * Monero splits data into 8-byte blocks, encodes each block independently,
 * and pads with leading '1's to fixed width per block.
 * @param {Uint8Array} data
 * @returns {string}
 */
function base58Encode(data) {
    const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    const BLOCK_SIZE = 8;
    const ENCODED_BLOCK_SIZES = [0, 2, 3, 5, 6, 7, 8, 9, 11];

    function encodeBlock(block) {
        let num = 0n;
        for (let i = 0; i < block.length; i++) {
            num = num * 256n + BigInt(block[i]);
        }
        let encoded = '';
        while (num > 0n) {
            const remainder = num % 58n;
            num = num / 58n;
            encoded = ALPHABET[Number(remainder)] + encoded;
        }
        // Pad with leading '1's (represents 0 in base58) to fixed block width
        const targetLen = ENCODED_BLOCK_SIZES[block.length];
        while (encoded.length < targetLen) {
            encoded = '1' + encoded;
        }
        return encoded;
    }

    let result = '';
    for (let i = 0; i < data.length; i += BLOCK_SIZE) {
        const block = data.slice(i, i + BLOCK_SIZE);
        result += encodeBlock(block);
    }
    return result;
}

/**
 * Compute Monero deposit address from user and LP public keys
 * @param {string} userCommitment - User's public key P_a (hex string with 0x prefix)
 * @param {string} lpPublicKey - LP's public key P_b (hex string with 0x prefix)
 * @param {string} lpPrivateViewKey - LP's private view key (hex string, for combined view key)
 * @returns {Promise<string>} - Monero deposit address
 */
export async function computeDepositAddress(userCommitment, lpPublicKey, lpPrivateViewKey = null) {
    // Remove 0x prefix and convert to Uint8Array
    const userBytes = hexToBytes(userCommitment);
    const lpBytes = hexToBytes(lpPublicKey);
    
    // Add the public spend keys: P_combined = P_a + P_b
    const combinedSpendKey = await addEd25519Points(userBytes, lpBytes);
    
    // For the view key, we need the combined public view key
    // In the simplified version, we can use LP's view key
    // In full Farcaster, both parties would exchange view keys too
    let combinedViewKey;
    
    if (lpPrivateViewKey) {
        // Derive public view key from private view key
        const ed = await import('https://esm.sh/@noble/ed25519@2.0.0');
        const privKeyBytes = hexToBytes(lpPrivateViewKey);
        combinedViewKey = ed.ExtendedPoint.BASE.multiply(BigInt('0x' + bytesToHex(privKeyBytes))).toRawBytes();
    } else {
        // Fallback: use LP's public spend key as view key (not cryptographically correct but works for demo)
        combinedViewKey = lpBytes;
    }
    
    // Derive Monero address
    const address = deriveMoneroAddress(combinedSpendKey, combinedViewKey, true);
    
    return address;
}

/**
 * Convert hex string to Uint8Array
 * @param {string} hex - Hex string (with or without 0x prefix)
 * @returns {Uint8Array}
 */
function hexToBytes(hex) {
    hex = hex.replace(/^0x/, '');
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < bytes.length; i++) {
        bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
    }
    return bytes;
}

/**
 * Convert Uint8Array to hex string
 * @param {Uint8Array} bytes
 * @returns {string}
 */
function bytesToHex(bytes) {
    return Array.from(bytes)
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
}
