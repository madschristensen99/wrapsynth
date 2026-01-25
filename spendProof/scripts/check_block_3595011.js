const hre = require('hardhat');
const { ethers } = hre;

async function main() {
    const WRAPPED_MONERO = '0xd53AB9c5789d202Ed45A596719D98a415da950f0';
    const wrappedMonero = await ethers.getContractAt('WrappedMoneroV3', WRAPPED_MONERO);
    
    const blockData = await wrappedMonero.moneroBlocks(3595011);
    
    console.log('Block 3595011 Data:');
    console.log('   TX Merkle Root:', blockData.txMerkleRoot);
    console.log('   Output Merkle Root:', blockData.outputMerkleRoot);
    console.log('   Exists:', blockData.exists);
}

main().then(() => process.exit(0)).catch(console.error);
