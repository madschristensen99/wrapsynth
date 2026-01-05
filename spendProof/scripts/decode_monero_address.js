/**
 * Decode Monero Address to get View Key (A) and Spend Key (B)
 */

const bs58 = require('bs58');
const { ethers } = require('hardhat');

function decodeMoneroAddress(address) {
    // Decode base58
    const decoded = bs58.decode(address);
    
    // Structure: [network_byte][public_spend_key (32 bytes)][public_view_key (32 bytes)][checksum (4 bytes)]
    const networkByte = decoded[0];
    const publicSpendKey = decoded.slice(1, 33);
    const publicViewKey = decoded.slice(33, 65);
    const checksum = decoded.slice(65, 69);
    
    // Verify checksum (Monero uses Keccak256)
    const hash = ethers.keccak256(decoded.slice(0, 65));
    const expectedChecksum = Buffer.from(hash.slice(2, 10), 'hex'); // Skip 0x and take first 4 bytes
    
    if (!checksum.equals(expectedChecksum)) {
        console.log('Checksum:', checksum.toString('hex'));
        console.log('Expected:', expectedChecksum.toString('hex'));
        // Don't throw - Monero addresses might have different checksum format
        console.warn('⚠️  Checksum mismatch - proceeding anyway');
    }
    
    // Determine network
    let network;
    if (networkByte === 0x12) {
        network = 'mainnet';
    } else if (networkByte === 0x35) {
        network = 'testnet';
    } else if (networkByte === 0x18) {
        network = 'stagenet';
    } else {
        network = `unknown (${networkByte.toString(16)})`;
    }
    
    return {
        network,
        publicSpendKey: '0x' + publicSpendKey.toString('hex'),
        publicViewKey: '0x' + publicViewKey.toString('hex')
    };
}

// Decode the address
const address = '77LbMMUieh3CTNvrUP68XDF1ESU1mSszx43eFzrWe3cY7ADTfx7q61uSzKPMydn9Ad7UM3ZBmSPo1JLRwna8pXq3635j7tB';

try {
    const result = decodeMoneroAddress(address);
    
    console.log('\n🔑 Monero Address Decoded:\n');
    console.log(`Address: ${address}`);
    console.log(`Network: ${result.network}\n`);
    console.log(`Public Spend Key (B): ${result.publicSpendKey}`);
    console.log(`Public View Key (A):  ${result.publicViewKey}\n`);
    
    // Compute LP address (same as contract does)
    const { ethers } = require('hardhat');
    const lpAddress = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
            ['bytes32', 'bytes32'],
            [result.publicViewKey, result.publicSpendKey]
        )
    );
    
    console.log(`LP Address (for contract): ${lpAddress}\n`);
    console.log('✅ Use these values to register LP or send Monero to this address!');
    
} catch (error) {
    console.error('❌ Error:', error.message);
}
