#!/usr/bin/env node
/**
 * Test RedStone oracle update on actual mainnet deployment
 */

const { ethers } = require('ethers');
const { WrapperBuilder } = require('@redstone-finance/evm-connector');
const { getSignersForDataServiceId } = require('@redstone-finance/oracles-smartweave-contracts');

const HUB_ADDRESS = '0x2eAe12Ba637e854dD5bDE99807929096cfb012f2';

async function main() {
    const rpcUrl = process.env.GNOSIS_RPC_URL || 'https://rpc.gnosischain.com';
    const privateKey = process.env.PRIVATE_KEY;
    
    if (!privateKey) {
        console.error('❌ PRIVATE_KEY not set');
        process.exit(1);
    }
    
    console.log('🧪 Testing RedStone Oracle on Mainnet');
    console.log('=====================================\n');
    
    const provider = new ethers.providers.JsonRpcProvider(rpcUrl);
    const wallet = new ethers.Wallet(privateKey, provider);
    
    const balance = await wallet.getBalance();
    console.log('Wallet:', wallet.address);
    console.log('Balance:', ethers.utils.formatEther(balance), 'xDAI');
    console.log('Hub:', HUB_ADDRESS);
    console.log('');
    
    try {
        // First check current prices
        const hubAbi = [
            'function updateOraclePrices(bytes[] calldata) external payable',
            'function getXmrPrice() external view returns (uint256)',
            'function getCollateralPrice() external view returns (uint256)',
            'function lastXmrPriceTimestamp() external view returns (uint256)',
            'function lastCollateralPriceTimestamp() external view returns (uint256)'
        ];
        
        const hub = new ethers.Contract(HUB_ADDRESS, hubAbi, wallet);
        
        console.log('📊 Checking current state...');
        
        let needsUpdate = false;
        try {
            const xmrPrice = await hub.getXmrPrice();
            const daiPrice = await hub.getCollateralPrice();
            const xmrTimestamp = await hub.lastXmrPriceTimestamp();
            const daiTimestamp = await hub.lastCollateralPriceTimestamp();
            
            console.log('   XMR Price: $' + ethers.utils.formatUnits(xmrPrice, 8));
            console.log('   DAI Price: $' + ethers.utils.formatUnits(daiPrice, 8));
            console.log('   XMR Updated:', new Date(xmrTimestamp * 1000).toLocaleString());
            console.log('   DAI Updated:', new Date(daiTimestamp * 1000).toLocaleString());
            
            const now = Math.floor(Date.now() / 1000);
            const xmrAge = now - xmrTimestamp;
            const daiAge = now - daiTimestamp;
            
            console.log('   XMR Age:', Math.floor(xmrAge / 60), 'minutes');
            console.log('   DAI Age:', Math.floor(daiAge / 60), 'minutes');
            console.log('');
            
            if (xmrAge > 120 || daiAge > 120) {
                needsUpdate = true;
            }
        } catch (error) {
            if (error.data === '0x19abf40e') {
                console.log('   ⚠️  Prices are STALE (StalePrice error)');
                needsUpdate = true;
            } else {
                throw error;
            }
        }
        console.log('');
        
        if (needsUpdate) {
            console.log('🔄 Prices need updating...');
            console.log('Attempting to update with RedStone...\n');
            
            // Try the wrapper
            console.log('📡 Wrapping contract with RedStone...');
            const authorizedSigners = getSignersForDataServiceId("redstone-primary-prod");
            console.log('   Using', authorizedSigners.length, 'authorized signers');
            
            const wrappedHub = WrapperBuilder
                .wrap(hub)
                .usingDataService({
                    dataServiceId: "redstone-primary-prod",
                    uniqueSignersCount: 3, // Contract requires at least 3 unique signers
                    dataPackagesIds: ["XMR", "DAI"],
                    authorizedSigners
                });
            
            console.log('📤 Sending update transaction...');
            const tx = await wrappedHub.updateOraclePrices([]);
            
            console.log('✅ Transaction sent:', tx.hash);
            console.log('⏳ Waiting for confirmation...');
            
            const receipt = await tx.wait();
            
            console.log('✅ Transaction confirmed!');
            console.log('   Block:', receipt.blockNumber);
            console.log('   Gas used:', receipt.gasUsed.toString());
            console.log('');
            
            // Read updated prices
            const newXmrPrice = await hub.getXmrPrice();
            const newDaiPrice = await hub.getCollateralPrice();
            
            console.log('📈 Updated Prices:');
            console.log('   XMR: $' + ethers.utils.formatUnits(newXmrPrice, 8));
            console.log('   DAI: $' + ethers.utils.formatUnits(newDaiPrice, 8));
            console.log('');
            console.log('🎉 Oracle update successful!');
            
        } else {
            console.log('✅ Prices are fresh (< 2 minutes old)');
            console.log('No update needed');
        }
        
    } catch (error) {
        console.error('\n❌ Error:', error.message);
        if (error.error) {
            console.error('Contract error:', error.error);
        }
        if (error.reason) {
            console.error('Reason:', error.reason);
        }
        console.error('\nFull error:');
        console.error(error);
        process.exit(1);
    }
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
