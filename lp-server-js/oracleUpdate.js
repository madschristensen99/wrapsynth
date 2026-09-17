// oracleUpdate.js — Shared RedStone oracle price update logic
// Used by both server.js (mint flow) and burnHandler.js (burn finalize)

import { getNextNonce, withTimeout, resetNonceCache } from './nonceManager.js';

let _hub = null;
let _wallet = null;
let _hubAddress = null;

export function setHubWallet(hub, wallet, hubAddress) {
  _hub = hub;
  _wallet = wallet;
  _hubAddress = hubAddress;
}

let _inFlight = null; // share one in-flight update across concurrent callers

export function updateOraclePricesManual() {
  // Dedupe: multiple mints can trigger this simultaneously, but a single oracle
  // update refreshes prices for all of them. Sharing the promise avoids sending
  // redundant txs (and the extra RPC load / nonce contention that causes hangs).
  if (_inFlight) return _inFlight;
  _inFlight = _updateOraclePrices().finally(() => { _inFlight = null; });
  return _inFlight;
}

async function _buildOracleCalldata() {
  const { DataServiceWrapper } = await import('@redstone-finance/evm-connector');
  const { getSignersForDataServiceId } = await import('@redstone-finance/oracles-smartweave-contracts');
  const authorizedSigners = getSignersForDataServiceId('redstone-primary-prod');

  const wrapper = new DataServiceWrapper({
    dataServiceId: 'redstone-primary-prod',
    uniqueSignersCount: 3,
    dataPackagesIds: ['XMR', 'DAI'],
    authorizedSigners,
  });

  const redstonePayload = await withTimeout(
    wrapper.getRedstonePayloadForManualUsage(_hub),
    30000,
    'RedStone payload fetch'
  );
  const baseData = _hub.interface.encodeFunctionData('updateOraclePrices', [[]]);
  return baseData + redstonePayload.slice(2);
}

// Broadcast an oracle price update with an explicit nonce and return the tx
// WITHOUT waiting for confirmation. Used to pipeline provideLPKey right after:
// same-account txs execute in nonce order, so a follow-up tx always sees the
// freshly-written price even if confirmation is slow.
export async function broadcastOracleUpdate(nonce) {
  if (!_hub || !_wallet) {
    throw new Error('Oracle update not initialized — call setHubWallet first');
  }
  const fullData = await _buildOracleCalldata();
  const updateTx = await withTimeout(
    _wallet.sendTransaction({ to: _hubAddress, data: fullData, nonce }),
    30000,
    'oracle update broadcast'
  );
  console.log(`[Oracle] Broadcast price update (tx: ${updateTx.hash}, nonce: ${nonce})`);
  return updateTx;
}

async function _updateOraclePrices() {
  if (!_hub || !_wallet) {
    throw new Error('Oracle update not initialized — call setHubWallet first');
  }

  console.log('[Oracle] Updating oracle prices...');
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const oracleNonce = await getNextNonce();
      const updateTx = await broadcastOracleUpdate(oracleNonce);
      await withTimeout(updateTx.wait(), 120000, 'oracle update confirmation');
      console.log(`[Oracle] Prices updated (tx: ${updateTx.hash})`);
      return;
    } catch (err) {
      lastErr = err;
      console.warn(`[Oracle] Attempt ${attempt + 1}/3 failed: ${err.shortMessage || err.message}`);
      if (err.data) console.warn(`[Oracle] Revert data: ${err.data}`);
      // A broadcast that timed out may still have landed, or the cached nonce may
      // be stale — resync from chain so the retry uses the correct nonce.
      const msg = (err.shortMessage || err.message || '').toLowerCase();
      if (msg.includes('nonce') || msg.includes('timed out')) {
        resetNonceCache();
      }
      if (attempt < 2) {
        const delay = 2000 * Math.pow(2, attempt);
        console.log(`[Oracle] Retry in ${delay / 1000}s... (${attempt + 2}/3)`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}
