// nonceManager.js — Per-chain nonce managers for serializing EVM transactions
// Prevents nonce conflicts between concurrent mint and burn operations.
// Each chain context gets its own manager via createNonceManager().

import * as ethers from 'ethers';

// Rejects `p` after `ms` so a hung RPC/fetch call can't stall the caller forever.
// The underlying promise keeps running in the background; we just stop awaiting it.
export function withTimeout(p, ms, label = 'operation') {
  return Promise.race([
    p,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}

/**
 * Create an independent nonce manager bound to one provider + sender.
 * Nonce state (cache + serialization lock) is fully isolated per chain —
 * a stuck RPC on one chain cannot stall tx signing on another.
 */
export function createNonceManager(provider, walletAddress) {
  let nonceLock = Promise.resolve();
  let cachedNonce = null;

  async function getNextNonce() {
    const run = nonceLock.then(async () => {
      if (cachedNonce === null) {
        // Timeout prevents a hung getTransactionCount from deadlocking the shared
        // lock chain (which would stall every subsequent transaction).
        cachedNonce = await withTimeout(
          provider.getTransactionCount(walletAddress, 'latest'),
          15000,
          'getTransactionCount'
        );
      }
      const nonce = cachedNonce;
      cachedNonce++;
      return nonce;
    });
    nonceLock = run.catch(() => {});
    return run;
  }

  function withNonceLock(fn) {
    const run = nonceLock.then(fn, fn);
    nonceLock = run.catch(() => {});
    return run;
  }

  function resetNonceCache() {
    cachedNonce = null;
  }

  return { getNextNonce, withNonceLock, resetNonceCache };
}

// ─── Legacy single-chain singleton ──────────────────────────────────────────
// Kept so the one-off scripts (cancel-mint.js, manual-setMintReady.js, …) keep
// working unchanged. New multi-chain code must use createNonceManager().
let _default = null;

export function initNonceManager(provider, walletAddress) {
  _default = createNonceManager(provider, walletAddress);
}

export function getNextNonce() { return _default.getNextNonce(); }
export function withNonceLock(fn) { return _default.withNonceLock(fn); }
export function resetNonceCache() { _default.resetNonceCache(); }
