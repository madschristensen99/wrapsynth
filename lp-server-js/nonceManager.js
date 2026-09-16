// nonceManager.js — Shared nonce manager for serializing EVM transactions
// Prevents nonce conflicts between concurrent mint and burn operations.

import * as ethers from 'ethers';

let _provider = null;
let _walletAddress = null;
let _nonceLock = Promise.resolve();
let _cachedNonce = null;

export function initNonceManager(provider, walletAddress) {
  _provider = provider;
  _walletAddress = walletAddress;
  _cachedNonce = null;
}

export async function getNextNonce() {
  const run = _nonceLock.then(async () => {
    if (_cachedNonce === null) {
      _cachedNonce = await _provider.getTransactionCount(_walletAddress, 'latest');
    }
    const nonce = _cachedNonce;
    _cachedNonce++;
    return nonce;
  });
  _nonceLock = run.catch(() => {});
  return run;
}

export function withNonceLock(fn) {
  const run = _nonceLock.then(fn, fn);
  _nonceLock = run.catch(() => {});
  return run;
}

export function resetNonceCache() {
  _cachedNonce = null;
}
