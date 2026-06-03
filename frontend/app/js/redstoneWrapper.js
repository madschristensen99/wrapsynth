// RedStone Oracle Price Update Helper
// Uses viem-redstone-connector to update prices with RedStone data

import { CONTRACTS, ABIS } from './config.js';
import { getWalletClient, getPublicClient } from './viemClient.js';

/**
 * Update oracle prices using RedStone
 * Uses @kreskolabs/viem-redstone-connector to inject RedStone price data
 */
export async function updateOraclePrices() {
    console.log('Updating oracle prices with RedStone...');
    
    try {
        // Import required modules
        const { getWalletClientRs } = await import('https://esm.sh/@kreskolabs/viem-redstone-connector@latest');
        const { custom } = await import('https://esm.sh/viem@2.7.0');
        const { gnosis } = await import('https://esm.sh/viem@2.7.0/chains');
        const { getUserAddress } = await import('./viemClient.js');
        
        const publicClient = getPublicClient();
        const account = getUserAddress();
        
        // RedStone configuration for primary-prod data service
        const dataServiceConfig = {
            dataServiceId: 'redstone-primary-prod',
            uniqueSignersCount: 3,
            urls: ['https://oracle-gateway-1.a.redstone.finance']
        };
        
        const dataFeeds = ['XMR', 'DAI'];
        
        // Create RedStone-wrapped wallet client
        const rsWalletClient = getWalletClientRs(
            {
                chain: gnosis,
                transport: custom(window.ethereum),
                account
            },
            dataServiceConfig,
            dataFeeds
        );
        
        console.log('Sending price update transaction...');
        
        // Parse ABI to proper format
        const { parseAbi } = await import('https://esm.sh/viem@2.7.0');
        const parsedAbi = parseAbi(ABIS.hub);
        
        // Call updateOraclePrices with RedStone data injection
        const hash = await rsWalletClient.rsWrite({
            address: CONTRACTS.hub,
            abi: parsedAbi,
            functionName: 'updateOraclePrices',
            args: [[]],
            dataFeeds: ['XMR', 'DAI']
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
