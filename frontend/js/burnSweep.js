/**
 * Burn Sweep Module - Claims XMR from shared burn address using browser WASM wallet
 *
 * After BurnFinalized, the LP's secret is revealed on-chain.
 * The browser combines user's private spend key + LP's secret to get the
 * full private spend key for the shared Monero address, then sweeps all
 * XMR to the user's destination address.
 *
 * Uses monero-ts WASM wallet (MoneroWalletFull) — no wallet RPC needed,
 * all operations happen client-side in the browser.
 */

import { MONERO_CONFIG } from './config.js?v=3.12';
import { createConnectedWalletFull } from './moneroRpc.js?v=3.12';

const ED25519_L = 2n ** 252n + 27742317777372353535851937790883648493n;

/**
 * Combine user's private spend key with LP's revealed secret
 * to derive the full private spend key for the shared address.
 *
 * @param {string} userSecretHex - User's private spend key (0x-prefixed hex)
 * @param {string} lpSecretHex - LP's revealed secret from BurnFinalized (0x-prefixed hex)
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
 * Sweep XMR from the shared burn address to the user's destination.
 *
 * @param {Object} params
 * @param {string} params.userSecretHex - User's private spend key (0x hex)
 * @param {string} params.lpSecretHex - LP's revealed secret (0x hex)
 * @param {string} params.userViewKeyHex - User's private view key (0x hex, big-endian)
 * @param {string} params.destination - Monero destination address
 * @param {number} params.restoreHeight - Block height to start scanning from
 * @param {Function} params.onProgress - Progress callback (message: string)
 * @param {boolean} params.lpSecretIsLe - lpSecretHex bytes are already the LE scalar
 *   encoding (mint deposits: lpSpendPub = LE(lpSecret)·G). Default false (burns: BE).
 * @param {string} params.viewKeyLeHex - private view key already in LE hex; overrides
 *   userViewKeyHex when set (mint deposits: view key = lpSecret bytes verbatim).
 * @param {string} [params.primaryAddress] - the shared/deposit address; derived from
 *   the combined keys when omitted. monero-ts requires it alongside privateViewKey.
 * @returns {Promise<{swept: boolean, txHashes: string[], amount: string}>}
 */
export async function sweepBurnOutput({ userSecretHex, lpSecretHex, userViewKeyHex, destination, restoreHeight = 0, onProgress, lpSecretIsLe = false, viewKeyLeHex = null, primaryAddress = null }) {
    const log = (msg) => {
        console.log('[BurnSweep]', msg);
        if (onProgress) onProgress(msg);
    };

    log('Combining spend keys...');
    const combinedSpendLe = combineSpendKeys(userSecretHex, lpSecretHex, lpSecretIsLe);
    const viewKeyLe = viewKeyLeHex || toLeHex(userViewKeyHex);

    log('Combined private spend key derived');

    // Load monero-ts WASM module
    log('Loading Monero WASM wallet...');
    let moneroTs;
    if (typeof window !== 'undefined' && window.monero_ts) {
        moneroTs = window.monero_ts;
    } else {
        throw new Error('Monero WASM module not loaded. Ensure monero-ts.js is included in the page.');
    }

    if (typeof moneroTs.createWalletFull !== 'function') {
        throw new Error('Monero WASM bundle does not include createWalletFull. Rebuild monero-ts.js with: node build-monero-ts.mjs');
    }

    // MoneroNetworkType.MAINNET = 0; fall back to numeric if enum not yet initialized
    const mainnetType = (moneroTs.MoneroNetworkType && moneroTs.MoneroNetworkType.MAINNET !== undefined)
        ? moneroTs.MoneroNetworkType.MAINNET
        : 0;

    // Create wallet from keys
    log('Creating wallet from keys...');

    // monero-ts requires primaryAddress whenever a private view key is given.
    // Prefer the caller's known address; otherwise derive it from the combined keys.
    if (!primaryAddress) {
        const ed = await import('https://esm.sh/@noble/ed25519@2.1.0');
        const Point = ed.ExtendedPoint || ed.Point;
        const leToScalar = (h) => BigInt('0x' + reverseHexBytes(h)) % ED25519_L;
        const pubSpend = Point.BASE.multiply(leToScalar(combinedSpendLe)).toRawBytes();
        const pubView = Point.BASE.multiply(leToScalar(viewKeyLe)).toRawBytes();
        const { deriveMoneroAddress } = await import('./moneroCrypto.js?v=3.12');
        primaryAddress = deriveMoneroAddress(pubSpend, pubView, true);
        log('Derived primary address from combined keys:', primaryAddress);
    }

    // Try each configured daemon until the wallet actually connects — a node that
    // answers /json_rpc may still lack the binary endpoints monero-ts needs.
    const { wallet } = await createConnectedWalletFull(moneroTs, {
        password: 'burn-sweep-tmp',
        networkType: mainnetType,
        primaryAddress,
        privateSpendKey: combinedSpendLe,
        privateViewKey: viewKeyLe,
        restoreHeight: restoreHeight,
        proxyToWorker: false,
    }, (url) => log(`Trying Monero node ${new URL(url).hostname}...`));

    try {
        // Refresh to scan for incoming transactions
        log('Scanning Monero blockchain for funds...');
        await wallet.startSyncing();
        await wallet.rescanSpent();

        // Wait for sync with timeout
        const syncTimeout = 120000; // 2 minutes
        const startTime = Date.now();
        let synced = false;
        while (Date.now() - startTime < syncTimeout) {
            const height = await wallet.getSyncHeight();
            const daemonHeight = await wallet.getDaemonHeight();
            if (height >= daemonHeight) {
                synced = true;
                log(`Wallet synced at height ${height}`);
                break;
            }
            log(`Syncing... ${height}/${daemonHeight}`);
            await new Promise(r => setTimeout(r, 3000));
        }

        if (!synced) {
            log('Sync timeout reached, attempting sweep anyway...');
        }

        // Check balance
        const balance = await wallet.getBalance();
        const unlockedBalance = await wallet.getUnlockedBalance();
        log(`Balance: ${balance.toString()} atomic (${unlockedBalance.toString()} unlocked)`);

        if (unlockedBalance.toString() === '0') {
            // Check if there's locked balance (not enough confirmations)
            if (balance.toString() !== '0') {
                log('Funds found but locked. Waiting for confirmations...');
                // Wait up to 5 minutes for unlock
                for (let i = 0; i < 30; i++) {
                    await new Promise(r => setTimeout(r, 10000));
                    const unlocked = await wallet.getUnlockedBalance();
                    if (unlocked.toString() !== '0') {
                        log('Funds unlocked!');
                        break;
                    }
                    if (i % 3 === 0) log(`Waiting for unlock... (${(i + 1) * 10}s)`);
                }
            } else {
                throw new Error('No balance found at shared address. The XMR may not have been sent yet, or the keys are incorrect.');
            }
        }

        // Sweep all funds to destination
        log(`Sweeping funds to ${destination}...`);
        const txs = await wallet.sweepUnlocked({
            address: destination,
            relay: true,
        });

        const txHashes = Array.isArray(txs) ? txs.map(t => t.getHash()) : [txs.getHash()];
        const totalAmount = Array.isArray(txs)
            ? txs.reduce((sum, t) => sum + BigInt(t.getAmount()), 0n)
            : BigInt(txs.getAmount());

        log(`Sweep complete! ${txHashes.length} tx(s), total ${totalAmount.toString()} atomic units`);
        log(`Tx hash: ${txHashes[0]}`);

        return {
            swept: true,
            txHashes,
            amount: totalAmount.toString(),
        };
    } finally {
        // Always close and clean up the wallet
        log('Cleaning up temporary wallet...');
        try {
            await wallet.close();
        } catch (e) {
            console.warn('[BurnSweep] Wallet close error:', e.message);
        }
    }
}

/**
 * Get the combined private keys for manual import (Option C fallback).
 * Returns keys formatted for Monero GUI wallet import.
 *
 * @param {string} userSecretHex - User's private spend key (0x hex)
 * @param {string} lpSecretHex - LP's revealed secret (0x hex)
 * @param {string} userViewKeyHex - User's private view key (0x hex)
 * @returns {{spendKey: string, viewKey: string, address: string}}
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
 * Derive the Monero address from combined keys for verification.
 * Uses @noble/ed25519 to compute the public spend key (user_pub + LP_pub)
 * and pairs it with the user's public view key.
 *
 * @param {string} userSecretHex - User's private spend key (0x hex)
 * @param {string} lpSecretHex - LP's revealed secret (0x hex)
 * @param {string} userViewKeyHex - User's private view key (0x hex)
 * @returns {Promise<string>} Expected Monero address
 */
export async function deriveExpectedAddress(userSecretHex, lpSecretHex, userViewKeyHex) {
    const ed = await import('https://esm.sh/@noble/ed25519@2.1.0');
    const Point = ed.ExtendedPoint || ed.Point;
    const ED25519_L = 2n ** 252n + 27742317777372353535851937790883648493n;

    const userSecret = BigInt(userSecretHex) % ED25519_L;
    const lpSecret = BigInt(lpSecretHex) % ED25519_L;
    const combined = (userSecret + lpSecret) % ED25519_L;

    const combinedPubSpend = Point.BASE.multiply(combined).toRawBytes();

    // Derive public view key from private view key
    const viewKeyClean = userViewKeyHex.replace(/^0x/, '').padStart(64, '0');
    const viewKeyBytes = new Uint8Array(32);
    for (let i = 0; i < 32; i++) {
        viewKeyBytes[i] = parseInt(viewKeyClean.substr(i * 2, 2), 16);
    }
    // View key is stored big-endian in the agent, convert to scalar
    const viewKeyBe = BigInt('0x' + viewKeyClean);
    const viewKeyLe = viewKeyBe % ED25519_L;
    const combinedPubView = Point.BASE.multiply(viewKeyLe).toRawBytes();

    // Use moneroCrypto to derive address
    const { deriveMoneroAddress } = await import('./moneroCrypto.js?v=3.12');
    return deriveMoneroAddress(combinedPubSpend, combinedPubView, true);
}
