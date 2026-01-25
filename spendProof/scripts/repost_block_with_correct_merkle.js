const hre = require('hardhat');
const { ethers } = hre;
const fs = require('fs');

async function main() {
    const [deployer] = await ethers.getSigners();
    
    const WRAPPED_MONERO = '0xd53AB9c5789d202Ed45A596719D98a415da950f0';
    const wrappedMonero = await ethers.getContractAt('WrappedMoneroV3', WRAPPED_MONERO);
    
    // Load our computed Merkle roots
    const merkleProofs = JSON.parse(fs.readFileSync('merkle_proofs.json', 'utf8'));
    
    const BLOCK_HEIGHT = 3594966;
    const BLOCK_HASH = '0x4fea31a1de14d4dd630dc6936ff17c9d0711f2473f62ff5067b51f07d66d4aef';
    
    console.log('📝 Reposting Block with Correct Merkle Roots\n');
    console.log('Block:', BLOCK_HEIGHT);
    console.log('TX Merkle Root (Keccak256):', merkleProofs.txMerkleRoot);
    console.log('Output Merkle Root (SHA256):', merkleProofs.outputMerkleRoot);
    console.log();
    
    console.log('🚀 Posting block...');
    const tx = await wrappedMonero.postMoneroBlock(
        BLOCK_HEIGHT,
        BLOCK_HASH,
        merkleProofs.txMerkleRoot,
        merkleProofs.outputMerkleRoot
    );
    
    console.log('   TX:', tx.hash);
    await tx.wait();
    console.log('✅ Block posted!');
    console.log();
    
    // Verify
    const blockData = await wrappedMonero.moneroBlocks(BLOCK_HEIGHT);
    console.log('📦 Verified Block Data:');
    console.log('   TX Merkle Root:', blockData.txMerkleRoot);
    console.log('   Output Merkle Root:', blockData.outputMerkleRoot);
    console.log('   Match:', 
        blockData.txMerkleRoot === merkleProofs.txMerkleRoot &&
        blockData.outputMerkleRoot === merkleProofs.outputMerkleRoot ? '✅' : '❌'
    );
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
