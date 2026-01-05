/**
 * Check what blocks have been posted
 */

const { ethers } = require('hardhat');
const fs = require('fs');
const path = require('path');

async function main() {
    // Load deployment info
    const deploymentPath = path.join(__dirname, '../oracle/deployment.json');
    const deploymentInfo = JSON.parse(fs.readFileSync(deploymentPath, 'utf8'));
    
    const provider = new ethers.JsonRpcProvider('http://localhost:8545');
    const MoneroBridge = await ethers.getContractFactory('MoneroBridge');
    const bridge = MoneroBridge.attach(deploymentInfo.bridge).connect(provider);
    
    console.log('\n📊 Checking posted blocks...\n');
    
    const latestBlock = await bridge.latestMoneroBlock();
    console.log(`Latest posted block: ${latestBlock.toString()}\n`);
    
    // Check specific blocks
    const blocksToCheck = [2028311, 2028323, 2028335];
    
    for (const height of blocksToCheck) {
        try {
            const blockData = await bridge.moneroBlocks(height);
            console.log(`Block ${height}:`);
            console.log(`   Hash: ${blockData.blockHash}`);
            console.log(`   TX Merkle Root: ${blockData.txMerkleRoot}`);
            console.log(`   Output Merkle Root: ${blockData.outputMerkleRoot}`);
            console.log(`   Posted: ${blockData.blockHash !== '0x0000000000000000000000000000000000000000000000000000000000000000'}\n`);
        } catch (error) {
            console.log(`Block ${height}: Error - ${error.message}\n`);
        }
    }
}

main().catch(console.error);
