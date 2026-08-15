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

import { MONERO_CONFIG } from './config.js';

const ED25519_L = 2n ** 252n + 27742317777372353535851937790883648493n;

/**
 * Combine user's private spend key with LP's revealed secret
 * to derive the full private spend key for the shared address.
 *
 * @param {string} userSecretHex - User's private spend key (0x-prefixed hex)
 * @param {string} lpSecretHex - LP's revealed secret from BurnFinalized (0x-prefixed hex)
 * @returns {string} Combined private spend key as little-endian hex (no 0x prefix)
 */
export function combineSpendKeys(userSecretHex, lpSecretHex) {
    const userSecret = BigInt(userSecretHex) % ED25519_L;
    const lpSecret = BigInt(lpSecretHex) % ED25519_L;
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
 * Convert a big-endian hex private key to little-endian hex (Monero format)
 * @param {string} hex - 0x-prefixed hex (big-endian)
 * @returns {string} little-endian hex (no 0x prefix)
 */
function toLeHex(hex) {
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
 * @param {string} params.userViewKeyHex - User's private view key (0x hex)
 * @param {string} params.destination - Monero destination address
 * @param {number} params.restoreHeight - Block height to start scanning from
 * @param {Function} params.onProgress - Progress callback (message: string)
 * @returns {Promise<{swept: boolean, txHashes: string[], amount: string}>}
 */
export async function sweepBurnOutput({ userSecretHex, lpSecretHex, userViewKeyHex, destination, restoreHeight = 0, onProgress }) {
    const log = (msg) => {
        console.log('[BurnSweep]', msg);
        if (onProgress) onProgress(msg);
    };

    log('Combining spend keys...');
    const combinedSpendLe = combineSpendKeys(userSecretHex, lpSecretHex);
    const viewKeyLe = toLeHex(userViewKeyHex);

    log('Combined private spend key derived');

    // Load monero-ts WASM module
    log('Loading Monero WASM wallet...');
    let moneroTs;
    if (typeof window !== 'undefined' && window.monero_ts) {
        moneroTs = window.monero_ts;
    } else {
        throw new Error('Monero WASM module not loaded. Ensure monero-ts.js is included in the page.');
    }

    // MoneroNetworkType.MAINNET = 0; fall back to numeric if enum not yet initialized
    const mainnetType = (moneroTs.MoneroNetworkType && moneroTs.MoneroNetworkType.MAINNET !== undefined)
        ? moneroTs.MoneroNetworkType.MAINNET
        : 0;

    // Create wallet from keys
    log('Creating wallet from keys...');
    const wallet = await moneroTs.createWalletFull({
        password: 'burn-sweep-tmp',
        networkType: mainnetType,
        privateSpendKey: combinedSpendLe,
        privateViewKey: viewKeyLe,
        serverUri: MONERO_CONFIG.rpcUrl,
        restoreHeight: restoreHeight,
    });

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
