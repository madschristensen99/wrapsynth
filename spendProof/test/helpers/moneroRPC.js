const axios = require('axios');

/**
 * Fetch real Monero block data from a public RPC node
 */
async function getMoneroBlockData(blockHeight, rpcUrl = 'https://monero-rpc.cheems.de.box.skhron.com.ua:18089') {
    try {
        // Get block hash by height
        const hashResponse = await axios.post(rpcUrl + '/json_rpc', {
            jsonrpc: '2.0',
            id: '0',
            method: 'on_get_block_hash',
            params: [blockHeight]
        });
        
        const blockHash = hashResponse.data.result;
        
        // Get block details
        const blockResponse = await axios.post(rpcUrl + '/json_rpc', {
            jsonrpc: '2.0',
            id: '0',
            method: 'get_block',
            params: {
                hash: blockHash
            }
        });
        
        const block = blockResponse.data.result;
        
        // Get current supply (approximate)
        const infoResponse = await axios.post(rpcUrl + '/json_rpc', {
            jsonrpc: '2.0',
            id: '0',
            method: 'get_info'
        });
        
        const info = infoResponse.data.result;
        
        return {
            height: blockHeight,
            hash: '0x' + blockHash,
            timestamp: block.block_header.timestamp,
            difficulty: block.block_header.difficulty,
            reward: block.block_header.reward,
            totalSupply: info.height * 2 * 1e12, // Rough estimate: ~2 XMR per block
            txCount: block.tx_hashes ? block.tx_hashes.length : 0
        };
    } catch (error) {
        console.error('Error fetching Monero block data:', error.message);
        throw error;
    }
}

/**
 * Get latest Monero block height
 */
async function getLatestBlockHeight(rpcUrl = 'https://monero-rpc.cheems.de.box.skhron.com.ua:18089') {
    try {
        const response = await axios.post(rpcUrl + '/json_rpc', {
            jsonrpc: '2.0',
            id: '0',
            method: 'get_block_count'
        });
        
        return response.data.result.count - 1; // Latest confirmed block
    } catch (error) {
        console.error('Error fetching latest block height:', error.message);
        throw error;
    }
}

module.exports = {
    getMoneroBlockData,
    getLatestBlockHeight
};
