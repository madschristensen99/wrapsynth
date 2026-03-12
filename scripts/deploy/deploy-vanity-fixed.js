const { ethers } = require('hardhat');
const fs = require('fs');
const crypto = require('crypto');

/**
 * Find vanity salt for CREATE2 deployment
 */
async function findVanitySalt(factoryAddress, bytecode, prefix, maxAttempts = 10000000) {
    console.log(`Searching for address starting with 0x${prefix}...`);
    
    const prefixLower = prefix.toLowerCase();
    const bytecodeHash = ethers.keccak256(bytecode);
    
    for (let i = 0; i < maxAttempts; i++) {
        const salt = ethers.hexlify(ethers.randomBytes(32));
        
        const address = ethers.getCreate2Address(
            factoryAddress,
            salt,
            bytecodeHash
        );
        
        if (address.toLowerCase().startsWith('0x' + prefixLower)) {
            console.log(`✅ Found after ${i + 1} attempts!`);
            console.log(`   Address: ${address}`);
            console.log(`   Salt: ${salt}`);
            return { address, salt };
        }
        
        if ((i + 1) % 100000 === 0) {
            console.log(`   Tried ${(i + 1).toLocaleString()} addresses...`);
        }
    }
    
    throw new Error(`Could not find vanity address after ${maxAttempts} attempts`);
}

async function main() {
    const [deployer] = await ethers.getSigners();
    console.log('Deploying with account:', deployer.address);
    console.log('Account balance:', ethers.formatEther(await ethers.provider.getBalance(deployer.address)));

    console.log('\n=== Step 1: Deploy CREATE2 Factory ===');
    const Create2Deployer = await ethers.getContractFactory('Create2Deployer');
    const factory = await Create2Deployer.deploy();
    await factory.waitForDeployment();
    const factoryAddress = await factory.getAddress();
    console.log('✅ CREATE2 Factory:', factoryAddress);
    
    console.log('\n=== Step 2: Generate Vanity Salts ===');
    
    // Get contract factories
    const wsXMR = await ethers.getContractFactory('wsXMR');
    const VaultManager = await ethers.getContractFactory('VaultManager');
    
    // We need to compute addresses in the right order due to circular dependency
    // VaultManager address is needed for wsXMR constructor
    // wsXMR address is needed for VaultManager constructor
    
    // First, find VaultManager salt (with placeholder wsXMR address)
    console.log('\n1. Finding VaultManager vanity (0xB00F...)');
    const placeholderAddress = ethers.ZeroAddress;
    const vaultManagerBytecodeWithPlaceholder = ethers.concat([
        VaultManager.bytecode,
        ethers.AbiCoder.defaultAbiCoder().encode(['address'], [placeholderAddress])
    ]);
    
    const vaultResult = await findVanitySalt(factoryAddress, vaultManagerBytecodeWithPlaceholder, 'b00f');
    
    // Now use the found VaultManager address to create wsXMR bytecode
    console.log('\n2. Finding wsXMR vanity (0x420...)');
    const wsxmrBytecode = ethers.concat([
        wsXMR.bytecode,
        ethers.AbiCoder.defaultAbiCoder().encode(['address'], [vaultResult.address])
    ]);
    
    const wsxmrResult = await findVanitySalt(factoryAddress, wsxmrBytecode, '420');
    
    console.log('\n=== Step 3: Deploy Contracts ===');
    
    // Deploy wsXMR with VaultManager address
    console.log('\n1. Deploying wsXMR (0x420...)...');
    const wsxmrTx = await factory.deploy(wsxmrResult.salt, wsxmrBytecode);
    await wsxmrTx.wait();
    console.log('   ✅ wsXMR deployed at:', wsxmrResult.address);
    
    // Deploy VaultManager with wsXMR address
    console.log('\n2. Deploying VaultManager (0xB00F...)...');
    const vaultManagerBytecode = ethers.concat([
        VaultManager.bytecode,
        ethers.AbiCoder.defaultAbiCoder().encode(['address'], [wsxmrResult.address])
    ]);
    
    const vaultTx = await factory.deploy(vaultResult.salt, vaultManagerBytecode);
    await vaultTx.wait();
    console.log('   ✅ VaultManager deployed at:', vaultResult.address);
    
    // Save deployment
    const deployment = {
        network: 'gnosis',
        chainId: 100,
        deployer: deployer.address,
        create2Factory: factoryAddress,
        wsXMR: wsxmrResult.address,
        vaultManager: vaultResult.address,
        salts: {
            wsxmr: wsxmrResult.salt,
            vaultManager: vaultResult.salt
        },
        timestamp: new Date().toISOString()
    };
    
    fs.writeFileSync(
        './deployments/gnosis-vanity.json',
        JSON.stringify(deployment, null, 2)
    );
    
    console.log('\n=== Deployment Complete ===');
    console.log(JSON.stringify(deployment, null, 2));
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
