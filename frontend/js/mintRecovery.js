/**
 * Mint Recovery Module — reclaim XMR from an LP-viewable mint deposit.
 *
 * Mint deposits are LP-VIEWABLE:
 *   deposit = ( view = lpSpendPub , spend = userPub + lpSpendPub )
 *   private view key  = lpSecret              (LE bytes verbatim)
 *   private spend key = userSecret + lpSecret (BE(userSecret) + LE(lpSecret))
 *
 * If the LP ghosts (or the mint is cancelled/expired) the LP's secret is revealed
 * on-chain. The user then combines their own secret with the LP secret to get the
 * full spend key, and imports the keys into a Monero wallet (GUI/Feather,
 * "Restore from keys") to claim the XMR manually.
 *
 * NOTE on endianness: the mint lpSecret's bytes are the little-endian scalar
 * encoding (lpSpendPub = LE(lpSecret)·G), unlike burn secrets which are
 * big-endian. The revealed on-chain value is the same byte string, so the
 * private view key for the deposit wallet is lpSecret verbatim.
 */

import { combineSpendKeys, reverseHexBytes } from './burnSweep.js?v=3.59';

/**
 * Derive the expected mint deposit address from the combined keys, so the user can
 * confirm they're about to sweep the right address before broadcasting.
 *
 *   view pub  = lpSecret·G                          (= lpSpendPub)
 *   spend pub = userSecret·G + lpSecret·G           (= userPub + lpSpendPub)
 *
 * userSecret is big-endian (on-chain convention); lpSecret bytes are the
 * little-endian scalar encoding (Monero convention used at provideLPKey).
 *
 * @param {string} userSecretHex - User's mint secret (0x hex, big-endian)
 * @param {string} lpSecretHex - LP's revealed secret (0x hex, LE scalar bytes)
 * @returns {Promise<string>} Expected Monero deposit address
 */
export async function deriveMintDepositAddress(userSecretHex, lpSecretHex) {
    const ed = await import('https://esm.sh/@noble/ed25519@2.1.0');
    const Point = ed.ExtendedPoint || ed.Point;
    const ED25519_L = 2n ** 252n + 27742317777372353535851937790883648493n;

    const userSecret = BigInt(userSecretHex) % ED25519_L;
    const lpSecret = BigInt('0x' + reverseHexBytes(lpSecretHex)) % ED25519_L;
    const combined = (userSecret + lpSecret) % ED25519_L;

    const lpSpendPub = Point.BASE.multiply(lpSecret).toRawBytes();         // view pub
    const combinedSpend = Point.BASE.multiply(combined).toRawBytes();    // spend pub

    const { deriveMoneroAddress } = await import('./moneroCrypto.js?v=3.59');
    return deriveMoneroAddress(combinedSpend, lpSpendPub, true);
}

/**
 * Get the combined keys for manual import into a Monero GUI/CLI wallet.
 * view key = lpSecret (LE bytes verbatim), spend key = userSecret + lpSecret (LE).
 *
 * @param {string} userSecretHex - User's mint secret (0x hex, big-endian)
 * @param {string} lpSecretHex - LP's revealed secret (0x hex, LE scalar bytes)
 * @returns {{spendKey: string, viewKey: string}}
 */
export function getMintKeysForImport(userSecretHex, lpSecretHex) {
    return {
        spendKey: combineSpendKeys(userSecretHex, lpSecretHex, true),
        viewKey: lpSecretHex.replace(/^0x/, ''), // already little-endian
    };
}
