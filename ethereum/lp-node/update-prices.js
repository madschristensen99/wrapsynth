#!/usr/bin/env node
/**
 * RedStone price updater - called by Rust LP node
 * Returns transaction hash of price update
 */

require('dotenv').config();
const { ethers } = require('ethers');
const { WrapperBuilder } = require('@redstone-finance/evm-connector');
const { getSignersForDataServiceId } = require('@redstone-finance/oracles-smartweave-contracts');

const HUB_ADDRESS = process.env.HUB_ADDRESS || '0xd32e2ece901094550b81ab5051a72256761514d6';
const PRIVATE_KEY = process.env.PRIVATE_KEY;
const RPC_URL = process.env.GNOSIS_RPC_URL || 'https://rpc.gnosischain.com';

async function updatePrices() {
    try {
        const provider = new ethers.JsonRpcProvider(RPC_URL);
        const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
        
        const hubAbi = [
            'function updateOraclePrices(bytes[] calldata updateData) external payable'
        ];
        
        const hub = new ethers.Contract(HUB_ADDRESS, hubAbi, wallet);
        
        // Wrap with RedStone
        const authorizedSigners = getSignersForDataServiceId('redstone-primary-prod');
        const wrappedHub = WrapperBuilder.wrap(hub).usingDataService({
            dataServiceId: 'redstone-primary-prod',
            uniqueSignersCount: 3,
            dataPackagesIds: ['XMR', 'DAI'],
            authorizedSigners
        });
        
        // Update prices
        const tx = await wrappedHub.updateOraclePrices([], { gasLimit: 500000 });
        await tx.wait();
        
        // Output just the tx hash for Rust to parse
        console.log(tx.hash);
        process.exit(0);
    } catch (error) {
        console.error('ERROR:', error.message);
        process.exit(1);
    }
}

updatePrices();
