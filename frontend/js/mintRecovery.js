/**
 * Mint Recovery Module — reclaim XMR from a user-viewable mint deposit.
 *
 * Mint deposits are USER-VIEWABLE:
 *   deposit = ( view = userPub , spend = userPub + lpSpendPub )
 *   private view key  = userSecret
 *   private spend key = userSecret + lpSecret
 *
 * If the LP ghosts (or the mint is cancelled/expired) the LP's secret is revealed
 * on-chain. The user then combines their own secret with the LP secret to get the
 * full spend key, and — because the view key is their own secret — can scan and
 * sweep the deposit with a normal MoneroWalletFull, exactly like the burn sweep.
 *
 * This is a thin wrapper over burnSweep.sweepBurnOutput: the only difference is
 * that the mint deposit's view key IS the user's spend secret.
 */

import { sweepBurnOutput, combineSpendKeys } from './burnSweep.js';

/**
 * Sweep XMR from a user-viewable mint deposit to the user's destination.
 *
 * @param {Object} params
 * @param {string} params.userSecretHex - User's mint secret / private spend key (0x hex)
 * @param {string} params.lpSecretHex - LP's revealed secret (0x hex)
 * @param {string} params.destination - Monero destination address
 * @param {number} params.restoreHeight - Block height to start scanning from (use the
 *                                        MintInitiated block or a bit before it)
 * @param {Function} params.onProgress - Progress callback (message: string)
 * @returns {Promise<{swept: boolean, txHashes: string[], amount: string}>}
 */
export async function sweepMintDeposit({ userSecretHex, lpSecretHex, destination, restoreHeight = 0, onProgress }) {
    // The mint deposit's view pub is userPub = userSecret·G, so the private view key
    // is simply userSecret. Reuse the burn sweep with the user's secret as the view key.
    return sweepBurnOutput({
        userSecretHex,
        lpSecretHex,
        userViewKeyHex: userSecretHex,
        destination,
        restoreHeight,
        onProgress,
    });
}

/**
 * Derive the expected mint deposit address from the combined keys, so the user can
 * confirm they're about to sweep the right address before broadcasting.
 *
 *   view pub  = userSecret·G            (= userPub)
 *   spend pub = (userSecret+lpSecret)·G (= userPub + lpSpendPub)
 *
 * @param {string} userSecretHex - User's mint secret (0x hex)
 * @param {string} lpSecretHex - LP's revealed secret (0x hex)
 * @returns {Promise<string>} Expected Monero deposit address
 */
export async function deriveMintDepositAddress(userSecretHex, lpSecretHex) {
    const ed = await import('https://esm.sh/@noble/ed25519@2.1.0');
    const Point = ed.ExtendedPoint || ed.Point;
    const ED25519_L = 2n ** 252n + 27742317777372353535851937790883648493n;

    const userSecret = BigInt(userSecretHex) % ED25519_L;
    const lpSecret = BigInt(lpSecretHex) % ED25519_L;
    const combined = (userSecret + lpSecret) % ED25519_L;

    const userPub = Point.BASE.multiply(userSecret).toRawBytes();          // view pub
    const combinedSpend = Point.BASE.multiply(combined).toRawBytes();      // spend pub

    const { deriveMoneroAddress } = await import('./moneroCrypto.js');
    return deriveMoneroAddress(combinedSpend, userPub, true);
}

/**
 * Get the combined keys for manual import into a Monero GUI/CLI wallet (fallback).
 * view key = userSecret (LE), spend key = userSecret + lpSecret (LE).
 *
 * @param {string} userSecretHex - User's mint secret (0x hex)
 * @param {string} lpSecretHex - LP's revealed secret (0x hex)
 * @returns {{spendKey: string, viewKey: string}}
 */
export function getMintKeysForImport(userSecretHex, lpSecretHex) {
    return {
        spendKey: combineSpendKeys(userSecretHex, lpSecretHex),
        viewKey: combineSpendKeys(userSecretHex, '0x0'), // userSecret mod L, little-endian
    };
}
