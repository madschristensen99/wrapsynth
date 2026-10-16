// RedStone Oracle Price Update Helper
// Manually builds calldata to avoid viem v1 / connector selector bugs with bytes[] params

import { CONTRACTS, ABIS } from './config.js?v=3.22';
import { getWalletClient, getPublicClient, getUserAddress, ensureAuthorizedAccount } from './viemClient.js?v=3.22';

/**
 * Update oracle prices using RedStone
 * Manually constructs transaction data: viem v2 encodeFunctionData + RedStone payload
 */
/**
 * Fetch current XMR and USDe prices from RedStone API (off-chain, no wallet needed).
 * Returns human-readable prices for UI display.
 */
export async function fetchRedStonePrices() {
    console.log('Fetching RedStone prices...');

    try {
        const resp = await fetch(
            'https://api.redstone.finance/prices?symbol=XMR,QQQ&provider=redstone-primary-prod&limit=1',
            { headers: { 'Accept': 'application/json' } }
        );
        if (!resp.ok) {
            throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
        }
        const data = await resp.json();
        console.log('RedStone API response:', data);

        // The API returns an array of price objects
        const prices = Array.isArray(data) ? data : (data.prices || []);

        const xmrEntry = prices.find(p => p.symbol === 'XMR' || p.symbol === 'XMR' );
        const usdeEntry = prices.find(p => p.symbol === 'QQQ');

        return {
            xmrPrice: xmrEntry ? Number(xmrEntry.value) : null,
            usdePrice: usdeEntry ? Number(usdeEntry.value) : null,
            xmrTimestamp: xmrEntry ? xmrEntry.timestamp : null,
            usdeTimestamp: usdeEntry ? usdeEntry.timestamp : null
        };
    } catch (error) {
        console.warn('Could not fetch RedStone prices from API:', error.message);
        // Fallback: return nulls so caller can still proceed with payload-based update
        return { xmrPrice: null, usdePrice: null, xmrTimestamp: null, usdeTimestamp: null };
    }
}

/**
 * Generate RedStone payload for updateOraclePrices (off-chain, no wallet needed).
 * Returns the hex payload bytes to be appended to the function selector.
 */
export async function buildRedStonePayload() {
    // Solana port: no calldata payload needed — sendPriceUpdate rewrites the
    // mock oracle account directly. Return a stub so callers keep working.
    return { functionData: null, redstonePayload: null };
}

/**
 * Send an updateOraclePrices transaction directly from the user's wallet.
 * Signs with MetaMask, then sends raw tx through an alternative RPC endpoint
 * because the default RPC may fail with InternalRpcError on large RedStone calldata.
 */
export async function sendPriceUpdate({ functionData, redstonePayload } = {}) {
    // Solana port — the devnet oracle is a mock account anyone can rewrite via
    // oracle-mock.write_account. The refresher daemon normally keeps feeds
    // fresh; this is the manual fallback path.
    console.log('Sending price update transaction (solana oracle-mock)...');
    const { writeHub } = await import('./viemClient.js?v=3.22');
    const receipt = await writeHub('updateOraclePrices', []);
    console.log('✅ Oracle prices updated, sig:', receipt.transactionHash);
    return receipt;
}

/**
 * Legacy all-in-one price update (fetch payload + send tx in one go).
 * Prefer fetchRedStonePrices → buildRedStonePayload → confirm → sendPriceUpdate
 * for flows where the user should see prices before signing.
 */
export async function updateOraclePrices() {
    console.log('Updating oracle prices with RedStone...');

    try {
        const payload = await buildRedStonePayload();
        const receipt = await sendPriceUpdate(payload);
        return true;
    } catch (error) {
        console.error('Failed to update oracle prices:', error);
        throw new Error(`Could not update oracle prices: ${error.message}`);
    }
}
