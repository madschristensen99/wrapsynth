const { ethers } = require('hardhat');
const crypto = require('crypto');

/**
 * Generate vanity address using CREATE2
 * @param {string} deployerAddress - Address that will deploy the contract
 * @param {string} bytecode - Contract bytecode
 * @param {string} prefix - Desired hex prefix (without 0x)
 * @param {number} maxAttempts - Maximum attempts before giving up
 */
async function findVanitySalt(deployerAddress, bytecode, prefix, maxAttempts = 10000000) {
    console.log(`\nSearching for address starting with 0x${prefix}...`);
    console.log(`Deployer: ${deployerAddress}`);
    
    const prefixLower = prefix.toLowerCase();
    const bytecodeHash = ethers.keccak256(bytecode);
    
    for (let i = 0; i < maxAttempts; i++) {
        // Generate random salt
        const salt = ethers.hexlify(ethers.randomBytes(32));
        
        // Calculate CREATE2 address
        const address = ethers.getCreate2Address(
            deployerAddress,
            salt,
            bytecodeHash
        );
        
        // Check if address matches prefix
        if (address.toLowerCase().startsWith('0x' + prefixLower)) {
            console.log(`✅ Found matching address after ${i + 1} attempts!`);
            console.log(`   Address: ${address}`);
            console.log(`   Salt: ${salt}`);
            return { address, salt };
        }
        
        // Progress update every 100k attempts
        if ((i + 1) % 100000 === 0) {
            console.log(`   Tried ${(i + 1).toLocaleString()} addresses...`);
        }
    }
    
    throw new Error(`Could not find vanity address after ${maxAttempts} attempts`);
}

async function main() {
    const [deployer] = await ethers.getSigners();
    console.log('Deployer address:', deployer.address);
    
    // Compile contracts to get bytecode
    const VaultManager = await ethers.getContractFactory('VaultManager');
    const wsXMR = await ethers.getContractFactory('wsXMR');
    
    // Get deployment bytecode (includes constructor args)
    const vaultManagerBytecode = VaultManager.bytecode;
    const wsxmrBytecode = wsXMR.bytecode;
    
    console.log('\n=== Vanity Address Generation ===');
    
    // Find vanity addresses
    const results = {};
    
    // VaultManager: 0xB00F...
    console.log('\n1. VaultManager (0xB00F...)');
    results.vaultManager = await findVanitySalt(deployer.address, vaultManagerBytecode, 'b00f');
    
    // wsXMR Token: 0x420...
    console.log('\n2. wsXMR Token (0x420...)');
    results.wsxmr = await findVanitySalt(deployer.address, wsxmrBytecode, '420');
    
    // Router: 0x247...
    // Note: Router deployment might need different approach depending on how it's deployed
    console.log('\n3. Router (0x247...)');
    console.log('   (Router vanity will be generated during actual deployment)');
    
    // Save results
    console.log('\n=== Results ===');
    console.log(JSON.stringify(results, null, 2));
    
    // Save to file
    const fs = require('fs');
    fs.writeFileSync(
        './scripts/vanity-salts.json',
        JSON.stringify(results, null, 2)
    );
    console.log('\n✅ Salts saved to scripts/vanity-salts.json');
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
