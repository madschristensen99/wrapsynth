/**
 * Burn Sweep Module - Key derivation for claiming XMR from a shared burn address
 *
 * After BurnFinalized, the LP's secret is revealed on-chain.
 * The browser combines user's private spend key + LP's secret to get the
 * full private spend key for the shared Monero address. The user imports
 * these keys into a Monero wallet (GUI/Feather, "Restore from keys") to
 * sweep the XMR manually — there is no in-browser WASM sweep.
 */

const ED25519_L = 2n ** 252n + 27742317777372353535851937790883648493n;

/**
 * Combine user's private spend key with LP's revealed secret
 * to derive the full private spend key for the shared address.
 *
 * @param {string} userSecretHex - User's private spend key (0x-prefixed hex)
 * @param {string} lpSecretHex - LP's revealed secret from BurnFinalized (0x-prefixed hex)
 * @param {boolean} lpSecretIsLe - true if lpSecret bytes are the little-endian scalar
 *   encoding (mint deposits), false for big-endian burn secrets
 * @returns {string} Combined private spend key as little-endian hex (no 0x prefix)
 */
export function combineSpendKeys(userSecretHex, lpSecretHex, lpSecretIsLe = false) {
    const userSecret = BigInt(userSecretHex) % ED25519_L;
    // Mint deposits use an lpSecret whose bytes are the little-endian scalar
    // encoding (lpSpendPub = LE(lpSecret)·G). Burn secrets are big-endian.
    const lpSecret = lpSecretIsLe
        ? BigInt('0x' + reverseHexBytes(lpSecretHex)) % ED25519_L
        : BigInt(lpSecretHex) % ED25519_L;
    const combined = (userSecret + lpSecret) % ED25519_L;

    // Convert to little-endian hex (Monero format)
    const combinedBe = combined.toString(16).padStart(64, '0');
    const bytes = new Uint8Array(32);
    for (let i = 0; i < 32; i++) {
        bytes[i] = parseInt(combinedBe.substr(i * 2, 2), 16);
    }
    bytes.reverse();
    return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Reverse the byte order of a hex string (BE <-> LE).
 * @param {string} hex - hex string, 0x prefix optional
 * @returns {string} reversed hex (no 0x prefix)
 */
export function reverseHexBytes(hex) {
    const clean = hex.replace(/^0x/, '').padStart(64, '0');
    const bytes = new Uint8Array(32);
    for (let i = 0; i < 32; i++) {
        bytes[i] = parseInt(clean.substr(i * 2, 2), 16);
    }
    bytes.reverse();
    return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Convert a big-endian hex private key to little-endian hex (Monero format)
 * @param {string} hex - 0x-prefixed hex (big-endian)
 * @returns {string} little-endian hex (no 0x prefix)
 */
export function toLeHex(hex) {
    const clean = hex.replace(/^0x/, '').padStart(64, '0');
    const bytes = new Uint8Array(32);
    for (let i = 0; i < 32; i++) {
        bytes[i] = parseInt(clean.substr(i * 2, 2), 16);
    }
    bytes.reverse();
    return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Get the combined private keys for manual import (Monero GUI/Feather,
 * "Restore from keys" — non-deterministic wallet).
 *
 * @param {string} userSecretHex - User's private spend key (0x hex)
 * @param {string} lpSecretHex - LP's revealed secret (0x hex)
 * @param {string} userViewKeyHex - User's private view key (0x hex)
 * @returns {{spendKey: string, viewKey: string}}
 */
export function getCombinedKeysForImport(userSecretHex, lpSecretHex, userViewKeyHex) {
    const combinedSpendLe = combineSpendKeys(userSecretHex, lpSecretHex);
    const viewKeyLe = toLeHex(userViewKeyHex);
    return {
        spendKey: combinedSpendLe,
        viewKey: viewKeyLe,
    };
}
