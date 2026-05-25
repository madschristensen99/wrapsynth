#!/usr/bin/env node
/**
 * Fetch prices from RedStone API for Foundry FFI
 * Returns ABI-encoded (uint256, uint256) for XMR and DAI prices
 */

const axios = require('axios');

async function main() {
    const symbols = process.argv[2] || 'XMR,DAI';
    
    const response = await axios.get('https://api.redstone.finance/prices', {
        params: {
            symbols,
            provider: 'redstone-primary-prod'
        }
    });
    
    const xmrPrice = Math.floor(response.data.XMR.value * 1e8);
    const daiPrice = Math.floor(response.data.DAI.value * 1e8);
    
    // ABI encode for Foundry
    const ethers = require('ethers');
    const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
        ['uint256', 'uint256'],
        [xmrPrice, daiPrice]
    );
    
    // Output raw bytes (Foundry FFI expects hex string with 0x prefix)
    process.stdout.write(encoded);
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
