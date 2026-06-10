#!/usr/bin/env node
require('dotenv').config();
const { ethers } = require('ethers');
const { HUB_ADDRESS } = require('./deploymentConfig');

async function main() {
    const provider = new ethers.providers.JsonRpcProvider('https://rpc.gnosischain.com');
    const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
    
    const hub = new ethers.Contract(HUB_ADDRESS, [
        'function unwindCoLP(uint256 tokenId, uint256 deadline) external',
        'function getPositionMetadata(uint256) view returns (tuple(address vaultOwner, address user, uint256 sDAISharesOriginal, uint256 wsxmrOriginal, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 createdAt))'
    ], wallet);
    
    const tokenId = 5528;
    const deadline = Math.floor(Date.now() / 1000) + 3600;
    
    console.log('Testing unwind of position', tokenId);
    console.log('Deadline:', deadline);
    console.log('');
    
    try {
        // Try to estimate gas to get the revert reason
        const gasEstimate = await hub.estimateGas.unwindCoLP(tokenId, deadline);
        console.log('Gas estimate:', gasEstimate.toString());
    } catch (err) {
        console.log('Revert reason:', err.reason || err.message);
        console.log('');
        if (err.error && err.error.data) {
            console.log('Error data:', err.error.data);
        }
        
        // Try to decode the error
        if (err.data) {
            console.log('Raw error data:', err.data);
        }
    }
}

main().catch(console.error);
