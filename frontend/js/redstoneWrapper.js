// RedStone Oracle Price Update Helper
// Manually builds calldata to avoid viem v1 / connector selector bugs with bytes[] params

import { CONTRACTS, ABIS, getActiveChain } from './config.js?v=3.53';
import { getWalletClient, getPublicClient, getUserAddress, ensureAuthorizedAccount, getViemChain } from './viemClient.js?v=3.53';

/**
 * Update oracle prices using RedStone
 * Manually constructs transaction data: viem v2 encodeFunctionData + RedStone payload
 */
/**
 * Fetch current prices for the active chain's RedStone feeds (off-chain, no wallet needed).
 * Returns human-readable prices for UI display.
 */
export async function fetchRedStonePrices() {
    console.log('Fetching RedStone prices...');

    const feeds = (getActiveChain()?.redstoneFeeds || ['XMR']).join(',');
    try {
        const resp = await fetch(
            `https://api.redstone.finance/prices?symbol=${feeds}&provider=redstone-primary-prod&limit=1`,
            { headers: { 'Accept': 'application/json' } }
        );
        if (!resp.ok) {
            throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
        }
        const data = await resp.json();
        console.log('RedStone API response:', data);

        // The API returns an array of price objects
        const prices = Array.isArray(data) ? data : (data.prices || []);

        const feedList = getActiveChain()?.redstoneFeeds || ['XMR'];
        const entry = (sym) => prices.find(p => p.symbol === sym || p.symbol === sym.toUpperCase());
        const xmrEntry = entry('XMR');
        const collSym = feedList.find(s => s !== 'XMR');
        const collEntry = collSym ? entry(collSym) : null;

        return {
            xmrPrice: xmrEntry ? Number(xmrEntry.value) : null,
            collateralPrice: collEntry ? Number(collEntry.value) : null,
            xmrTimestamp: xmrEntry ? xmrEntry.timestamp : null,
            collateralTimestamp: collEntry ? collEntry.timestamp : null
        };
    } catch (error) {
        console.warn('Could not fetch RedStone prices from API:', error.message);
        // Fallback: return nulls so caller can still proceed with payload-based update
        return { xmrPrice: null, collateralPrice: null, xmrTimestamp: null, collateralTimestamp: null };
    }
}

/**
 * Generate RedStone payload for updateOraclePrices (off-chain, no wallet needed).
 * Returns the hex payload bytes to be appended to the function selector.
 */
export async function buildRedStonePayload() {
    const { getWalletClientRs } = await import('https://esm.sh/@kreskolabs/viem-redstone-connector@latest');
    const { custom } = await import('https://esm.sh/viem@2.7.0');
    const { parseAbi, encodeFunctionData } = await import('https://esm.sh/viem@2.7.0');
    const chain = getViemChain();

    const account = getUserAddress();

    const dataServiceConfig = {
        dataServiceId: 'redstone-primary-prod',
        uniqueSignersCount: 3,
        // Public RedStone gateway. The frontend must stay fully on-chain —
        // no LP-server dependency. If the public gateway is sunset, fall
        // back to the hub's stored prices (kept fresh by server-side pushes).
        urls: [
            'https://oracle-gateway-1.a.redstone.finance'
        ]
    };
    const dataFeeds = getActiveChain()?.redstoneFeeds || ['XMR'];

    const rsWalletClient = getWalletClientRs(
        { chain, transport: custom(window.ethereum), account },
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
 * because the default RPC may fail with InternalRpcError on large RedStone calldata.
 */
export async function sendPriceUpdate({ functionData, redstonePayload }) {
    console.log('Sending price update transaction...');

    const walletClient = getWalletClient();
    const publicClient = getPublicClient();
    // Re-sync with the wallet's authorized account for this origin — a stale
    // cached address makes eth_sendTransaction throw 4100 'not authorized'.
    const account = await ensureAuthorizedAccount();
    const { createPublicClient, http } = await import('https://esm.sh/viem@2.7.0');

    const data = functionData + redstonePayload;

    // Verify wallet is on the selected chain before signing
    const chainCfg = getActiveChain();
    const currentChainId = await window.ethereum.request({ method: 'eth_chainId' });
    if (parseInt(currentChainId, 16) !== chainCfg.chainId) {
        throw new Error(`Please switch your wallet to ${chainCfg.name} (Chain ID ${chainCfg.chainId}) to continue.`);
    }

    // Send directly via the wallet provider — bypasses viem transport entirely
    // The wallet handles signing + broadcasting through its own RPC
    console.log('Sending oracle update tx via wallet provider...');
    const txHash = await window.ethereum.request({
        method: 'eth_sendTransaction',
        params: [{
            from: account,
            to: CONTRACTS.hub,
            data,
            gas: '0x1e8480', // 2000000
        }]
    });
    console.log(`✅ Tx sent: ${txHash}`);

    // Wait for receipt using the public client
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });

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
