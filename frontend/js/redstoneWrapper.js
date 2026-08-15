// RedStone Oracle Price Update Helper
// Manually builds calldata to avoid viem v1 / connector selector bugs with bytes[] params

import { CONTRACTS, ABIS } from './config.js';
import { getWalletClient, getPublicClient, getUserAddress } from './viemClient.js';

/**
 * Update oracle prices using RedStone
 * Manually constructs transaction data: viem v2 encodeFunctionData + RedStone payload
 */
/**
 * Fetch current XMR and DAI prices from RedStone API (off-chain, no wallet needed).
 * Returns human-readable prices for UI display.
 */
export async function fetchRedStonePrices() {
    console.log('Fetching RedStone prices...');

    try {
        const resp = await fetch(
            'https://api.redstone.finance/prices?symbol=XMR,DAI&provider=redstone-primary-prod&limit=1',
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
        const daiEntry = prices.find(p => p.symbol === 'DAI' || p.symbol === 'DAI');

        return {
            xmrPrice: xmrEntry ? Number(xmrEntry.value) : null,
            daiPrice: daiEntry ? Number(daiEntry.value) : null,
            xmrTimestamp: xmrEntry ? xmrEntry.timestamp : null,
            daiTimestamp: daiEntry ? daiEntry.timestamp : null
        };
    } catch (error) {
        console.warn('Could not fetch RedStone prices from API:', error.message);
        // Fallback: return nulls so caller can still proceed with payload-based update
        return { xmrPrice: null, daiPrice: null, xmrTimestamp: null, daiTimestamp: null };
    }
}

/**
 * Generate RedStone payload for updateOraclePrices (off-chain, no wallet needed).
 * Returns the hex payload bytes to be appended to the function selector.
 */
export async function buildRedStonePayload() {
    const { getWalletClientRs } = await import('https://esm.sh/@kreskolabs/viem-redstone-connector@latest');
    const { custom } = await import('https://esm.sh/viem@2.7.0');
    const { gnosis } = await import('https://esm.sh/viem@2.7.0/chains');
    const { parseAbi, encodeFunctionData } = await import('https://esm.sh/viem@2.7.0');

    const account = getUserAddress();

    const dataServiceConfig = {
        dataServiceId: 'redstone-primary-prod',
        uniqueSignersCount: 3,
        urls: ['https://oracle-gateway-1.a.redstone.finance']
    };
    const dataFeeds = ['XMR', 'DAI'];

    const rsWalletClient = getWalletClientRs(
        { chain: gnosis, transport: custom(window.ethereum), account },
        dataServiceConfig,
        dataFeeds
    );

    const redstonePayload = await rsWalletClient.rs.getPayload(null, dataFeeds);

    const oracleAbi = parseAbi(['function updateOraclePrices(bytes[] calldata) external payable']);
    const functionData = encodeFunctionData({
        abi: oracleAbi,
        functionName: 'updateOraclePrices',
        args: [[]]
    });

    return { functionData, redstonePayload };
}

/**
 * Send an updateOraclePrices transaction directly from the user's wallet.
 * Signs with MetaMask, then sends raw tx through an alternative RPC endpoint
 * because the default Gnosis RPC fails with InternalRpcError on large RedStone calldata.
 */
export async function sendPriceUpdate({ functionData, redstonePayload }) {
    console.log('Sending price update transaction...');

    const walletClient = getWalletClient();
    const publicClient = getPublicClient();
    const account = getUserAddress();
    const { gnosis } = await import('https://esm.sh/viem@2.7.0/chains');
    const { createPublicClient, http } = await import('https://esm.sh/viem@2.7.0');

    const data = functionData + redstonePayload;

    // Get nonce from public client
    const nonce = await publicClient.getTransactionCount({ address: account });

    // Sign the transaction with MetaMask
    const serializedTx = await walletClient.signTransaction({
        account,
        chain: gnosis,
        to: CONTRACTS.hub,
        data,
        gas: 2000000n,
        gasPrice: 1000000000n,
        nonce,
    });

    // Send raw tx through alternative RPCs (some Gnosis RPCs can't handle large RedStone calldata)
    const rpcUrls = [
        'https://gnosis-rpc.publicnode.com',
        'https://rpc.gnosis.gateway.fm',
        'https://rpc.gnosischain.com',
    ];
    let hash;
    let lastErr;
    for (const rpcUrl of rpcUrls) {
        try {
            console.log(`Trying RPC: ${rpcUrl}...`);
            const altClient = createPublicClient({
                chain: gnosis,
                transport: http(rpcUrl, { retryCount: 1, timeout: 15000 })
            });
            hash = await altClient.sendRawTransaction({ serializedTransaction: serializedTx });
            console.log(`✅ Accepted by ${rpcUrl}`);
            break;
        } catch (err) {
            console.warn(`RPC ${rpcUrl} failed:`, err.message);
            lastErr = err;
        }
    }
    if (!hash) throw lastErr;

    // Wait for receipt using the normal public client
    const receipt = await publicClient.waitForTransactionReceipt({ hash });

    console.log('✅ Oracle prices updated successfully');
    console.log('TX:', receipt.transactionHash);
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
