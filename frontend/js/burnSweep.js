/**
 * Burn Sweep Module - Key derivation for claiming XMR from a shared burn address
 *
 * After BurnFinalized, the LP's secret is revealed on-chain.
 * The browser combines user's private spend key + LP's secret to get the
 * full private spend key for the shared Monero address. The user imports
 * these keys into a Monero wallet (GUI/Feather, "Restore from keys") to
 * sweep the XMR manually — there is no in-browser WASM sweep.
 */

import { readHub } from './viemClient.js?v=3.53';
import { computeBurnAddress } from './moneroCrypto.js?v=3.53';

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

/**
 * Rebuild the claim keys for a completed burn from persisted browser state +
 * on-chain data. Reads the per-burn key set written by burnFlow (localStorage),
 * fetches the LP's revealed secret and public keys from the contract, re-derives
 * the shared Monero address, and returns the combined keys for manual import.
 *
 * @param {string} requestId - burn request id (0x hex)
 * @returns {Promise<{keys: {spendKey: string, viewKey: string}, sharedAddress: string, restoreHeight: number}>}
 * @throws {Error} with a user-facing message if keys are unavailable or the LP
 *   has not revealed its secret yet.
 */
export async function buildBurnClaimKeys(requestId) {
    // 1. Persisted per-burn key set (written at burn creation, survives completion)
    let d;
    try {
        const raw = localStorage.getItem('wrapsynth_burn_keyset_' + requestId);
        if (!raw) throw new Error('missing');
        d = JSON.parse(raw);
    } catch {
        throw new Error('Claim keys were not found in this browser. They only exist in the browser where the burn was created.');
    }
    const bytes = (h) => Uint8Array.from(h.slice(2).match(/../g).map(x => parseInt(x, 16)));
    const keySet = {
        secret: d.secret,
        privateViewKey: BigInt(d.privateViewKey),
        publicSpendKey: bytes(d.publicSpendKey),
        publicViewKey: bytes(d.publicViewKey),
        commitment: d.commitment,
        burnNonce: d.burnNonce,
    };

    // 2. LP data from on-chain
    let burnReq, lpSpendKey;
    try {
        burnReq = await readHub('getBurnRequest', [requestId]);
        lpSpendKey = await readHub('burnLpPublicKeys', [requestId]);
    } catch (e) {
        throw new Error('Could not read the burn from the chain: ' + (e.message || e));
    }
    const lpSecret = burnReq.revealedSecret;
    if (!lpSecret || lpSecret === '0x' + '0'.repeat(64)) {
        throw new Error('The LP has not revealed its secret on-chain yet — the burn must be finalized before claiming.');
    }

    // 3. Re-derive the shared Monero address from user + LP public keys
    const userPublicKey = '0x' + Array.from(keySet.publicSpendKey).map(b => b.toString(16).padStart(2, '0')).join('');
    const userViewPub = '0x' + Array.from(keySet.publicViewKey).map(b => b.toString(16).padStart(2, '0')).join('');
    const sharedAddress = await computeBurnAddress(userPublicKey, userViewPub, lpSpendKey);

    // 4. Combined private keys for wallet import
    const userViewKeyHex = '0x' + keySet.privateViewKey.toString(16).padStart(64, '0');
    const keys = getCombinedKeysForImport(keySet.secret, lpSecret, userViewKeyHex);

    // 5. Restore height hint — the LP's XMR tx is recent, so a deep window is safe.
    //    Never block the claim on a slow daemon: time out and fall back to 0.
    let restoreHeight = 0;
    try {
        const { getMoneroRpc } = await import('./moneroRpc.js?v=3.53');
        const height = await Promise.race([
            getMoneroRpc().getHeight(),
            new Promise((_, reject) => setTimeout(() => reject(new Error('daemon height timed out')), 4000))
        ]);
        restoreHeight = Math.max(0, height - 1000);
    } catch { /* leave 0 — modal shows a generic hint */ }

    return { keys, sharedAddress, restoreHeight };
}
