const hre = require('hardhat');
const { ethers } = hre;
const fs = require('fs');

async function main() {
    const WRAPPED_MONERO = '0xd53AB9c5789d202Ed45A596719D98a415da950f0';
    const wrappedMonero = await ethers.getContractAt('WrappedMoneroV3', WRAPPED_MONERO);
    
    const merkleProofs = JSON.parse(fs.readFileSync('merkle_proofs.json', 'utf8'));
    const TX_HASH = '0x4a0b26bf7311320e933c4effb423b6c7b128a235cbc725b4b65b0b86cda817c3';
    
    console.log('Testing Merkle Verification\n');
    console.log('TX Hash:', TX_HASH);
    console.log('Block Height:', merkleProofs.blockHeight);
    console.log('TX Index:', merkleProofs.txIndex);
    console.log('TX Proof:', merkleProofs.txMerkleProof);
    console.log();
    
    try {
        const result = await wrappedMonero.verifyTxInBlock(
            TX_HASH,
            merkleProofs.blockHeight,
            merkleProofs.txMerkleProof,
            merkleProofs.txIndex
        );
        
        console.log('✅ Merkle verification result:', result);
    } catch (error) {
        console.log('❌ Merkle verification failed:', error.message);
        
        // Try to get block data
        const blockData = await wrappedMonero.moneroBlocks(merkleProofs.blockHeight);
        console.log('\nBlock data:');
        console.log('   TX Merkle Root:', blockData.txMerkleRoot);
        console.log('   Exists:', blockData.exists);
        console.log('\nExpected TX Merkle Root:', merkleProofs.txMerkleRoot);
        console.log('Match:', blockData.txMerkleRoot === merkleProofs.txMerkleRoot);
    }
}

main().then(() => process.exit(0)).catch(console.error);
