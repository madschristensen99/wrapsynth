// oracleUpdate.js — Per-chain RedStone oracle price update logic
// Each chain context gets its own updater via createOracleUpdater() — the
// hub address, signing wallet, nonce manager, and feed set all differ per
// chain (collateral feeds are on-chain TWAP on BNB/Base/Robinhood, so only
// XMR needs a RedStone payload by default).

import { withTimeout, getNextNonce, resetNonceCache } from './nonceManager.js';

/**
 * @param {object} opts
 *   hub         - ethers.Contract bound to the chain's hub (read+call)
 *   wallet      - ethers.Wallet on the chain's provider
 *   hubAddress  - hub contract address (tx `to`)
 *   nonceMgr    - createNonceManager() result for this chain
 *   dataFeeds   - RedStone feed ids for this chain (default ['XMR'])
 *   chainLabel  - prefix for log lines (default 'chain')
 */
export function createOracleUpdater({ hub, wallet, hubAddress, nonceMgr, dataFeeds, chainLabel }) {
  const feeds = dataFeeds || ['XMR'];
  const tag = `[${chainLabel || 'oracle'}]`;
  let inFlight = null; // share one in-flight update across concurrent callers

  async function buildCalldata() {
    const { DataServiceWrapper } = await import('@redstone-finance/evm-connector');
    const { getSignersForDataServiceId } = await import('@redstone-finance/oracles-smartweave-contracts');
    const authorizedSigners = getSignersForDataServiceId('redstone-primary-prod');

    const wrapper = new DataServiceWrapper({
      dataServiceId: 'redstone-primary-prod',
      uniqueSignersCount: 3,
      dataPackagesIds: feeds,
      authorizedSigners,
    });

    const redstonePayload = await withTimeout(
      wrapper.getRedstonePayloadForManualUsage(hub),
      30000,
      'RedStone payload fetch'
    );
    const baseData = hub.interface.encodeFunctionData('updateOraclePrices', [[]]);
    return baseData + redstonePayload.slice(2);
  }

  // Broadcast an oracle price update with an explicit nonce and return the tx
  // WITHOUT waiting for confirmation. Used to pipeline provideLPKey right after:
  // same-account txs execute in nonce order, so a follow-up tx always sees the
  // freshly-written price even if confirmation is slow.
  async function broadcastOracleUpdate(nonce) {
    const fullData = await buildCalldata();
    const updateTx = await withTimeout(
      wallet.sendTransaction({ to: hubAddress, data: fullData, nonce }),
      30000,
      'oracle update broadcast'
    );
    console.log(`${tag} Broadcast price update (tx: ${updateTx.hash}, nonce: ${nonce})`);
    return updateTx;
  }

  async function _updateOraclePrices() {
    console.log(`${tag} Updating oracle prices (feeds: ${feeds.join(',')})...`);
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const oracleNonce = await nonceMgr.getNextNonce();
        const updateTx = await broadcastOracleUpdate(oracleNonce);
        await withTimeout(updateTx.wait(), 120000, 'oracle update confirmation');
        console.log(`${tag} Prices updated (tx: ${updateTx.hash})`);
        return;
      } catch (err) {
        lastErr = err;
        console.warn(`${tag} Attempt ${attempt + 1}/3 failed: ${err.shortMessage || err.message}`);
        if (err.data) console.warn(`${tag} Revert data: ${err.data}`);
        // A broadcast that timed out may still have landed, or the cached nonce may
        // be stale — resync from chain so the retry uses the correct nonce.
        const msg = (err.shortMessage || err.message || '').toLowerCase();
        if (msg.includes('nonce') || msg.includes('timed out')) {
          nonceMgr.resetNonceCache();
        }
        if (attempt < 2) {
          const delay = 2000 * Math.pow(2, attempt);
          console.log(`${tag} Retry in ${delay / 1000}s... (${attempt + 2}/3)`);
          await new Promise(r => setTimeout(r, delay));
        }
      }
    }
    throw lastErr;
  }

  function updateOraclePricesManual() {
    // Dedupe: multiple mints can trigger this simultaneously, but a single oracle
    // update refreshes prices for all of them. Sharing the promise avoids sending
    // redundant txs (and the extra RPC load / nonce contention that causes hangs).
    if (inFlight) return inFlight;
    inFlight = _updateOraclePrices().finally(() => { inFlight = null; });
    return inFlight;
  }

  return { updateOraclePricesManual, broadcastOracleUpdate };
}

// ─── Legacy single-chain singleton ──────────────────────────────────────────
// Kept so one-off scripts keep working. Multi-chain code uses
// createOracleUpdater() bound to a chain context.
let _default = null;

export function setHubWallet(hub, wallet, hubAddress) {
  _default = createOracleUpdater({
    hub, wallet, hubAddress,
    nonceMgr: { getNextNonce, resetNonceCache },
    dataFeeds: ['XMR', 'DAI'],
    chainLabel: 'Oracle',
  });
}

export function updateOraclePricesManual() {
  if (!_default) throw new Error('Oracle update not initialized — call setHubWallet first');
  return _default.updateOraclePricesManual();
}

export function broadcastOracleUpdate(nonce) {
  if (!_default) throw new Error('Oracle update not initialized — call setHubWallet first');
  return _default.broadcastOracleUpdate(nonce);
}
