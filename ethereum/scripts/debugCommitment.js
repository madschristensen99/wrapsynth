// Debug script to verify commitment generation matches between JS and Solidity
const { ethers } = require('hardhat');
const { keccak256 } = require('ethers');
const config = require('./deploymentConfig');

async function main() {
    // Get the Ed25519Helper contract
    const ed25519HelperAddress = config.ED25519_HELPER;
    const Ed25519Helper = await ethers.getContractAt('Ed25519Helper', ed25519HelperAddress);
    
    // Test secret from the error
    const secret = '0x057e581e1182afd422b732e2f3b22d24ce29a7d983adfdac407e0973546b04cf';
    
    console.log('Testing secret:', secret);
    
    // Get the commitment from Solidity
    const solidityCommitment = await Ed25519Helper.computeCommitment(secret);
    console.log('Solidity commitment:', solidityCommitment);
    
    // Get the public key point from Solidity
    const [px, py] = await Ed25519Helper.scalarMultBase(secret);
    console.log('Solidity px:', px.toString());
    console.log('Solidity py:', py.toString());
    
    // Manually compute commitment to verify
    const pxHex = px.toString(16).padStart(64, '0');
    const pyHex = py.toString(16).padStart(64, '0');
    const packed = '0x' + pxHex + pyHex;
    const manualCommitment = keccak256(packed);
    console.log('Manual commitment:', manualCommitment);
    console.log('Match:', solidityCommitment === manualCommitment);
    
    // Now check what was stored in the mint request
    const requestId = '0x97704b6cd0cd9196204717e50dd4ffea33ef12a95666f5d9b4c56f3f23afa399';
    const hub = await ethers.getContractAt('DiamondHub', config.HUB_ADDRESS);
    const mintRequest = await hub.getMintRequest(requestId);
    
    console.log('\nMint Request Info:');
    console.log('Stored commitment:', mintRequest.claimCommitment);
    console.log('User public key:', mintRequest.userPublicKey);
    console.log('Status:', mintRequest.status);
    
    console.log('\nComparison:');
    console.log('Secret generates commitment:', solidityCommitment);
    console.log('Stored commitment:         ', mintRequest.claimCommitment);
    console.log('Match:', solidityCommitment === mintRequest.claimCommitment);
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
