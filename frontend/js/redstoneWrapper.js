// RedStone Oracle Price Update Helper
// Manually builds calldata to avoid viem v1 / connector selector bugs with bytes[] params

import { CONTRACTS, ABIS } from './config.js';
import { getWalletClient, getPublicClient, getUserAddress } from './viemClient.js';

/**
 * Update oracle prices using RedStone
 * Manually constructs transaction data: viem v2 encodeFunctionData + RedStone payload
 */
export async function updateOraclePrices() {
    console.log('Updating oracle prices with RedStone...');

    try {
        // Import connector for payload generation only
        const { getWalletClientRs } = await import('https://esm.sh/@kreskolabs/viem-redstone-connector@latest');
        const { custom } = await import('https://esm.sh/viem@2.7.0');
        const { gnosis } = await import('https://esm.sh/viem@2.7.0/chains');
        const { parseAbi, encodeFunctionData } = await import('https://esm.sh/viem@2.7.0');

        const walletClient = getWalletClient();
        const publicClient = getPublicClient();
        const account = getUserAddress();

        // RedStone configuration for primary-prod data service
        const dataServiceConfig = {
            dataServiceId: 'redstone-primary-prod',
            uniqueSignersCount: 3,
            urls: ['https://oracle-gateway-1.a.redstone.finance']
        };

        const dataFeeds = ['XMR', 'DAI'];

        // Create RedStone-wrapped wallet client (used only for payload generation)
        const rsWalletClient = getWalletClientRs(
            { chain: gnosis, transport: custom(window.ethereum), account },
            dataServiceConfig,
            dataFeeds
        );

        console.log('Fetching RedStone payload...');

        // Fetch RedStone payload (pass null/undefined to get real data, not mocks)
        const redstonePayload = await rsWalletClient.rs.getPayload(null, dataFeeds);
        console.log('RedStone payload fetched:', redstonePayload.slice(0, 50) + '...');

        // Encode function call with viem v2 (correct selector for updateOraclePrices(bytes[]))
        const oracleAbi = parseAbi(['function updateOraclePrices(bytes[] calldata) external payable']);
        const functionData = encodeFunctionData({
            abi: oracleAbi,
            functionName: 'updateOraclePrices',
            args: [[]]
        });
        console.log('Function data:', functionData.slice(0, 20) + '...');

        // Concatenate: functionData (with 0x) + redstonePayload (without 0x)
        const data = functionData + redstonePayload;

        console.log('Sending price update transaction...');

        const hash = await walletClient.sendTransaction({
            to: CONTRACTS.hub,
            data,
            account,
            chain: gnosis
        });

        const receipt = await publicClient.waitForTransactionReceipt({ hash });

        console.log('✅ Oracle prices updated successfully');
        console.log('TX:', receipt.transactionHash);
        return true;
    } catch (error) {
        console.error('Failed to update oracle prices:', error);
        throw new Error(`Could not update oracle prices: ${error.message}`);
    }
}
