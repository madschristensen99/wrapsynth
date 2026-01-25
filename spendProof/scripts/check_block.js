const hre = require('hardhat');
const { ethers } = hre;

async function main() {
    const WRAPPED_MONERO = '0xd53AB9c5789d202Ed45A596719D98a415da950f0';
    const wrappedMonero = await ethers.getContractAt('WrappedMoneroV3', WRAPPED_MONERO);
    
    const blockHeight = 3594966;
    const latestBlock = await wrappedMonero.latestMoneroBlock();
    
    console.log('📊 Oracle Status:');
    console.log('   Latest Posted Block:', latestBlock.toString());
    console.log('   Your TX Block:', blockHeight);
    
    if (BigInt(blockHeight) <= latestBlock) {
        console.log('\n✅ Block', blockHeight, 'has been posted!');
        const blockData = await wrappedMonero.moneroBlocks(blockHeight);
        console.log('\n📦 Block Data:');
        console.log('   Block Hash:', blockData.blockHash);
        console.log('   TX Merkle Root:', blockData.txMerkleRoot);
        console.log('   Output Merkle Root:', blockData.outputMerkleRoot);
        console.log('   Exists:', blockData.exists);
        console.log('\n🎉 Ready to generate proof and mint!');
    } else {
        console.log('\n⏳ Block not posted yet. Waiting...');
        console.log('   Blocks behind:', blockHeight - Number(latestBlock));
    }
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
