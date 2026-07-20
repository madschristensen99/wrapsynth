// oracleUpdate.js — Shared RedStone oracle price update logic
// Used by both server.js (mint flow) and burnHandler.js (burn finalize)

let _hub = null;
let _wallet = null;
let _hubAddress = null;

export function setHubWallet(hub, wallet, hubAddress) {
  _hub = hub;
  _wallet = wallet;
  _hubAddress = hubAddress;
}

export async function updateOraclePricesManual() {
  if (!_hub || !_wallet) {
    throw new Error('Oracle update not initialized — call setHubWallet first');
  }

  const { DataServiceWrapper } = await import('@redstone-finance/evm-connector');
  const { getSignersForDataServiceId } = await import('@redstone-finance/oracles-smartweave-contracts');
  const authorizedSigners = getSignersForDataServiceId('redstone-primary-prod');

  const wrapper = new DataServiceWrapper({
    dataServiceId: 'redstone-primary-prod',
    uniqueSignersCount: 3,
    dataPackagesIds: ['XMR', 'DAI'],
    authorizedSigners,
  });

  console.log('[Oracle] Updating oracle prices...');
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const redstonePayload = await wrapper.getRedstonePayloadForManualUsage(_hub);

      const baseData = _hub.interface.encodeFunctionData('updateOraclePrices', [[]]);
      const fullData = baseData + redstonePayload.slice(2);

      const updateTx = await _wallet.sendTransaction({
        to: _hubAddress,
        data: fullData,
      });
      await updateTx.wait();
      console.log(`[Oracle] Prices updated (tx: ${updateTx.hash})`);
      return;
    } catch (err) {
      lastErr = err;
      if (attempt < 2) {
        const delay = 2000 * Math.pow(2, attempt);
        console.log(`[Oracle] Retry in ${delay / 1000}s... (${attempt + 2}/3)`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}
