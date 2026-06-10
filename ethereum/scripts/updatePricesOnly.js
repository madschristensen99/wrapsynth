require('dotenv').config();
const { ethers } = require('ethers');
const { WrapperBuilder } = require('@redstone-finance/evm-connector');
const { getSignersForDataServiceId } = require('@redstone-finance/oracles-smartweave-contracts');

const deployment = require('./deploymentConfig');

async function main() {
    const provider = new ethers.providers.JsonRpcProvider('https://rpc.gnosischain.com');
    const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
    
    const hub = new ethers.Contract(deployment.HUB_ADDRESS, [
        'function updateOraclePrices(bytes[] calldata) external payable'
    ], wallet);
    
    console.log('Updating RedStone oracle prices...');
    
    try {
        const authorizedSigners = getSignersForDataServiceId("redstone-primary-prod");
        const wrappedHub = WrapperBuilder.wrap(hub).usingDataService({
            dataServiceId: "redstone-primary-prod",
            uniqueSignersCount: 3,
            dataPackagesIds: ["XMR", "DAI"],
            authorizedSigners
        });
        
        const tx = await wrappedHub.updateOraclePrices([]);
        console.log('TX:', tx.hash);
        await tx.wait();
        console.log('✅ Prices updated');
        
        // Verify prices are fresh
        const hubRead = new ethers.Contract(deployment.HUB_ADDRESS, [
            'function getXmrPrice() view returns (uint256)',
            'function getCollateralPrice() view returns (uint256)'
        ], provider);
        
        const xmr = await hubRead.getXmrPrice();
        const dai = await hubRead.getCollateralPrice();
        console.log('XMR price:', ethers.utils.formatUnits(xmr, 18), 'USD');
        console.log('DAI price:', ethers.utils.formatUnits(dai, 18), 'USD');
    } catch (err) {
        console.error('Failed:', err.message);
        if (err.reason) console.error('Revert reason:', err.reason);
    }
}
main().catch(console.error);
