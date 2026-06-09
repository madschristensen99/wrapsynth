// Encrypted Seed Storage for WrapSynth
// Based on MoneroSwap's two-layer encryption approach
// 
// Security Model:
// - Layer 1: Seed encrypted with non-extractable browser key (IndexedDB)
// - Layer 2: IV encrypted with signature-derived key
// - Requires BOTH browser access AND wallet signature to decrypt

import { keccak256, hexToBytes, bytesToHex } from 'https://esm.sh/viem@2.7.0';
import { getWalletClient, getUserAddress } from './viemClient.js';

const DB_NAME = 'WrapSynth';
const STORE_NAME = 'keys';
const KEY_ID = 'seed-encryption-key';
const STORAGE_VERSION = 'v2';

/**
 * Retrieve or generate a browser-specific non-extractable AES-GCM encryption key
 * stored in IndexedDB. The key never leaves the browser.
 */
async function getOrCreateEncryptionKey() {
    const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, 1);
        request.onupgradeneeded = () => {
            request.result.createObjectStore(STORE_NAME);
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });

    const existing = await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const store = tx.objectStore(STORE_NAME);
        const request = store.get(KEY_ID);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });

    if (existing) {
        db.close();
        return existing;
    }

    // Generate non-extractable key
    const key = await window.crypto.subtle.generateKey(
        { name: 'AES-GCM', length: 256 },
        false, // NOT extractable - key stays in browser
        ['encrypt', 'decrypt']
    );

    await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        const store = tx.objectStore(STORE_NAME);
        const request = store.put(key, KEY_ID);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
    });

    db.close();
    return key;
}

/**
 * Generate storage key for a seed based on user address and public key
 */
function getStorageKey(userAddress, publicSpendKey) {
    // Format: chainId/contractAddress/publicKey/userAddress
    // For WrapSynth, we use a simplified version since we don't have multiple contracts
    // Normalize address to lowercase because localStorage is case-sensitive and
    // wallets may return checksummed or lowercase inconsistently.
    return `wrapsynth/${publicSpendKey}/${userAddress.toLowerCase()}`;
}

/**
 * Store encrypted seed in browser
 * 
 * @param {string} seed - BIP-39 seed phrase (12 or 24 words)
 * @param {string} publicSpendKey - Public key derived from seed (for storage key)
 * @returns {Promise<boolean>} Success status
 */
export async function storeSeed(seed, publicSpendKey) {
    const userAddress = getUserAddress();
    if (!userAddress) {
        throw new Error('Wallet not connected');
    }

    const storageKey = getStorageKey(userAddress, publicSpendKey);
    
    try {
        // Request signature from user
        const message = `WrapSynth seed storage: ${storageKey}`;
        const walletClient = getWalletClient();
        
        console.log('Requesting signature to encrypt seed...');
        const signature = await walletClient.signMessage({
            account: userAddress,
            message: message
        });

        // Derive encryption key from signature
        const keySeed = keccak256(signature);
        const sigKey = await window.crypto.subtle.importKey(
            'raw',
            hexToBytes(keySeed),
            { name: 'AES-GCM' },
            false,
            ['encrypt', 'decrypt']
        );

        // Get or create browser-specific non-extractable key
        const browserKey = await getOrCreateEncryptionKey();

        // Generate random IV for seed encryption
        const iv = window.crypto.getRandomValues(new Uint8Array(12));

        // Encrypt seed with browser key
        const encoder = new TextEncoder();
        const encryptedSeed = await window.crypto.subtle.encrypt(
            { name: 'AES-GCM', iv },
            browserKey,
            encoder.encode(seed)
        );

        // Encrypt IV with signature-derived key
        // Zero IV is safe here: unique key (from signature), single use
        const zeroIV = new Uint8Array(12);
        const encryptedIV = await window.crypto.subtle.encrypt(
            { name: 'AES-GCM', iv: zeroIV },
            sigKey,
            iv
        );

        // Store in localStorage: "v2:encryptedIV:encryptedSeed"
        const storageValue = `${STORAGE_VERSION}:${bytesToHex(new Uint8Array(encryptedIV))}:${bytesToHex(new Uint8Array(encryptedSeed))}`;
        localStorage.setItem(storageKey, storageValue);

        console.log('[SUCCESS] Seed encrypted and stored successfully');
        console.warn('[WARNING] This seed is only accessible from this browser with your wallet signature');
        
        return true;
    } catch (error) {
        console.error('Failed to store seed:', error);
        return false;
    }
}

/**
 * Check if a seed is stored for given public key
 * 
 * @param {string} publicSpendKey - Public key to check
 * @returns {boolean} True if seed exists
 */
export function hasStoredSeed(publicSpendKey) {
    const userAddress = getUserAddress();
    if (!userAddress) return false;

    const storageKey = getStorageKey(userAddress, publicSpendKey);
    return localStorage.getItem(storageKey) !== null;
}

/**
 * Load and decrypt seed from browser storage
 * 
 * @param {string} publicSpendKey - Public key to identify the seed
 * @returns {Promise<string|null>} Decrypted seed phrase or null if not found
 */
async function tryDecryptSeed(stored, message, userAddress) {
    const walletClient = getWalletClient();

    console.log('Requesting signature to decrypt seed...');
    const signature = await walletClient.signMessage({
        account: userAddress,
        message: message
    });

    // Derive decryption key from signature
    const keySeed = keccak256(signature);
    const sigKey = await window.crypto.subtle.importKey(
        'raw',
        hexToBytes(keySeed),
        { name: 'AES-GCM' },
        false,
        ['encrypt', 'decrypt']
    );

    // Parse stored data: "v2:encryptedIV:encryptedSeed"
    const parts = stored.slice(3).split(':');
    if (parts.length !== 2) {
        console.error('Invalid storage format');
        return null;
    }

    const encryptedIV = hexToBytes(parts[0]);
    const encryptedSeed = hexToBytes(parts[1]);

    // Decrypt IV with signature-derived key
    const zeroIV = new Uint8Array(12);
    const iv = new Uint8Array(
        await window.crypto.subtle.decrypt(
            { name: 'AES-GCM', iv: zeroIV },
            sigKey,
            encryptedIV
        )
    );

    // Decrypt seed with browser key
    const browserKey = await getOrCreateEncryptionKey();
    const decryptedSeedBytes = await window.crypto.subtle.decrypt(
        { name: 'AES-GCM', iv },
        browserKey,
        encryptedSeed
    );

    const decoder = new TextDecoder();
    return decoder.decode(decryptedSeedBytes);
}

export async function loadSeed(publicSpendKey) {
    const userAddress = getUserAddress();
    if (!userAddress) {
        throw new Error('Wallet not connected');
    }

    const storageKey = getStorageKey(userAddress, publicSpendKey);
    const stored = localStorage.getItem(storageKey);

    if (!stored) {
        return null;
    }

    // Check version
    if (!stored.startsWith(`${STORAGE_VERSION}:`)) {
        console.error('Unsupported storage version');
        return null;
    }

    // Try new lowercase message first
    try {
        const message = `WrapSynth seed storage: ${storageKey}`;
        const seed = await tryDecryptSeed(stored, message, userAddress);
        console.log('[SUCCESS] Seed decrypted successfully');
        return seed;
    } catch (error) {
        // If the wallet returned a mixed-case address when the seed was stored,
        // the signature was computed over a message with the raw address.
        // Try the legacy message as a fallback.
        if (userAddress !== userAddress.toLowerCase()) {
            console.warn('Decryption with lowercase key failed, trying legacy mixed-case key...');
            try {
                const legacyStorageKey = `wrapsynth/${publicSpendKey}/${userAddress}`;
                const legacyMessage = `WrapSynth seed storage: ${legacyStorageKey}`;
                const seed = await tryDecryptSeed(stored, legacyMessage, userAddress);
                console.log('[SUCCESS] Seed decrypted with legacy key');
                return seed;
            } catch (legacyError) {
                console.error('Legacy decryption also failed:', legacyError);
            }
        }
        console.error('Failed to decrypt seed:', error);
        return null;
    }
}

/**
 * Delete stored seed
 * 
 * @param {string} publicSpendKey - Public key to identify the seed
 * @returns {boolean} True if deleted
 */
export function deleteSeed(publicSpendKey) {
    const userAddress = getUserAddress();
    if (!userAddress) return false;

    const storageKey = getStorageKey(userAddress, publicSpendKey);
    localStorage.removeItem(storageKey);
    
    console.log('[INFO] Seed deleted from storage');
    return true;
}

/**
 * Clear all stored seeds for current user
 */
export function clearAllSeeds() {
    const userAddress = getUserAddress();
    if (!userAddress) return;

    const prefix = `wrapsynth/`;
    const keysToDelete = [];
    
    for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && key.startsWith(prefix) && key.endsWith(`/${userAddress}`)) {
            keysToDelete.push(key);
        }
    }

    keysToDelete.forEach(key => localStorage.removeItem(key));
    console.log(`[INFO] Cleared ${keysToDelete.length} stored seeds`);
}
