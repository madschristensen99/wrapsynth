// Pyth Oracle Integration
// Fetches price updates from Hermes API and formats for contract calls

import { PYTH_CONFIG } from './config.js';
import { getPublicClient } from './viemClient.js';
import { parseAbi } from 'https://esm.sh/viem@2.7.0';

/**
 * Fetch latest price update from Pyth Hermes API
 * @param {string[]} priceIds - Array of price feed IDs
 * @returns {Object} Price update data
 */
export async function fetchPythPriceUpdate(priceIds) {
    // Use Hermes v2 API - returns hex-encoded data in binary.data field
    const url = new URL('https://hermes.pyth.network/v2/updates/price/latest');
    priceIds.forEach(id => {
        url.searchParams.append('ids[]', id);
    });

    console.log('Fetching Pyth price update from:', url.toString());

    try {
        const response = await fetch(url.toString());
        
        if (!response.ok) {
            throw new Error(`Pyth API error: ${response.status} ${response.statusText}`);
        }

        const data = await response.json();
        
        // Check for data in either binary.data or direct data array
        const hasData = (data.binary && data.binary.data && data.binary.data.length > 0) ||
                       (data.data && data.data.length > 0);
        
        if (!hasData) {
            throw new Error('No price data received from Pyth');
        }

        console.log('Pyth price update received:', data);

        return data;
    } catch (error) {
        console.error('Error fetching Pyth price update:', error);
        throw error;
    }
}

/**
 * Format Pyth price update data for contract call
 * @param {Object} pythData - Data from Pyth Hermes API
 * @returns {string[]} Array of bytes strings for contract
 */
export function formatPythUpdateData(pythData) {
    if (!pythData.binary || !pythData.binary.data) {
        throw new Error('Invalid Pyth data format - missing binary.data');
    }

    // According to Pyth docs, binary.data contains hex-encoded strings
    // The encoding field tells us the format (should be "hex")
    const updateData = pythData.binary.data;
    
    // Ensure each hex string has 0x prefix
    const hexData = updateData.map(hexStr => {
        return hexStr.startsWith('0x') ? hexStr : '0x' + hexStr;
    });

    console.log('Formatted Pyth update data:', hexData);
    return hexData;
}

/**
 * Get the fee required to update Pyth prices
 * @param {string[]} updateData - Formatted price update data
 * @param {string} pythOracleAddress - Pyth oracle contract address
 * @returns {bigint} Fee in wei
 */
export async function getPythUpdateFee(updateData, pythOracleAddress) {
    const client = getPublicClient();
    
    try {
        const fee = await client.readContract({
            address: pythOracleAddress,
            abi: parseAbi([
                'function getUpdateFee(bytes[] calldata updateData) external view returns (uint256 feeAmount)'
            ]),
            functionName: 'getUpdateFee',
            args: [updateData]
        });

        console.log('Pyth update fee:', fee.toString(), 'wei');

        return fee;
    } catch (error) {
        console.error('Error getting Pyth update fee:', error);
        // Return a default fee if we can't fetch it
        return 1n;
    }
}

/**
 * Fetch and format price updates for XMR and sDAI
 * @returns {Object} Formatted update data and fee
 */
export async function getPriceUpdates() {
    // Fetch updates for both XMR/USD and sDAI/USD (contract collateral)
    const priceIds = [
        PYTH_CONFIG.priceIds.xmrUsd,
        PYTH_CONFIG.priceIds.sdaiUsd
    ];

    const pythData = await fetchPythPriceUpdate(priceIds);
    const updateData = formatPythUpdateData(pythData);

    return {
        updateData,
        pythData
    };
}

/**
 * Parse Pyth price from the response
 * @param {Object} pythData - Raw Pyth data
 * @param {string} priceId - Price feed ID
 * @returns {Object} Parsed price data
 */
export function parsePythPrice(pythData, priceId) {
    if (!pythData.parsed) {
        throw new Error('No parsed data in Pyth response');
    }

    const priceData = pythData.parsed.find(p => p.id === priceId);
    
    if (!priceData) {
        throw new Error(`Price data not found for ${priceId}`);
    }

    const price = priceData.price;
    
    return {
        price: BigInt(price.price),
        conf: BigInt(price.conf),
        expo: price.expo,
        publishTime: price.publish_time,
        // Calculate actual price: price * 10^expo
        formattedPrice: Number(price.price) * Math.pow(10, price.expo)
    };
}

/**
 * Get current XMR/USD price
 * @returns {Object} XMR price data
 */
export async function getXmrPrice() {
    const pythData = await fetchPythPriceUpdate([PYTH_CONFIG.priceIds.xmrUsd]);
    return parsePythPrice(pythData, PYTH_CONFIG.priceIds.xmrUsd);
}

/**
 * Get current ETH/USD price
 * @returns {Object} ETH price data
 */
export async function getEthPrice() {
    const pythData = await fetchPythPriceUpdate([PYTH_CONFIG.priceIds.ethUsd]);
    return parsePythPrice(pythData, PYTH_CONFIG.priceIds.ethUsd);
}

/**
 * Check if price update is needed (based on staleness)
 * @param {number} lastUpdateTime - Last update timestamp
 * @param {number} maxAge - Maximum age in seconds (default: 300 = 5 minutes)
 * @returns {boolean} True if update is needed
 */
export function isPriceUpdateNeeded(lastUpdateTime, maxAge = 300) {
    const now = Math.floor(Date.now() / 1000);
    return (now - lastUpdateTime) > maxAge;
}
