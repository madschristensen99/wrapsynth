const { ethers } = require('hardhat');
const fs = require('fs');

async function main() {
    const [deployer] = await ethers.getSigners();
    console.log('Deploying with account:', deployer.address);
    console.log('Account balance:', ethers.formatEther(await ethers.provider.getBalance(deployer.address)));

    // Load vanity salts
    const salts = JSON.parse(fs.readFileSync('./scripts/vanity-salts.json', 'utf8'));
    
    console.log('\n=== Deploying with Vanity Addresses ===');
    
    // 1. Deploy CREATE2 factory
    console.log('\n1. Deploying CREATE2 factory...');
    const Create2Deployer = await ethers.getContractFactory('Create2Deployer');
    const factory = await Create2Deployer.deploy();
    await factory.waitForDeployment();
    const factoryAddress = await factory.getAddress();
    console.log('   CREATE2 Factory:', factoryAddress);
    
    // 2. Deploy VaultManager first (wsXMR needs its address in constructor)
    console.log('\n2. Computing VaultManager address...');
    const vaultManagerAddress = salts.vaultManager.address;
    console.log('   VaultManager will be at:', vaultManagerAddress);
    
    // 3. Deploy wsXMR token with VaultManager address in constructor
    console.log('\n3. Deploying wsXMR token (0x420...)...');
    const wsXMR = await ethers.getContractFactory('wsXMR');
    const wsxmrBytecode = ethers.concat([
        wsXMR.bytecode,
        ethers.AbiCoder.defaultAbiCoder().encode(['address'], [vaultManagerAddress])
    ]);
    
    const wsxmrTx = await factory.deploy(salts.wsxmr.salt, wsxmrBytecode);
    await wsxmrTx.wait();
    
    const wsxmrAddress = salts.wsxmr.address;
    console.log('   ✅ wsXMR deployed at:', wsxmrAddress);
    
    // 4. Deploy VaultManager with wsXMR address
    console.log('\n4. Deploying VaultManager (0xB00F...)...');
    const VaultManager = await ethers.getContractFactory('VaultManager');
    const vaultManagerBytecode = ethers.concat([
        VaultManager.bytecode,
        ethers.AbiCoder.defaultAbiCoder().encode(['address'], [wsxmrAddress])
    ]);
    
    const vaultTx = await factory.deploy(salts.vaultManager.salt, vaultManagerBytecode);
    await vaultTx.wait();
    console.log('   ✅ VaultManager deployed at:', vaultManagerAddress);
    
    // 5. Find vanity address for Router (0x247...)
    console.log('\n5. Finding vanity address for Router (0x247...)...');
    // Router deployment will be done separately as it may have different dependencies
    
    // Save deployment addresses
    const deployment = {
        network: 'gnosis',
        chainId: 100,
        deployer: deployer.address,
        create2Factory: factoryAddress,
        wsXMR: wsxmrAddress,
        vaultManager: vaultManagerAddress,
        timestamp: new Date().toISOString()
    };
    
    fs.writeFileSync(
        './deployments/gnosis-vanity.json',
        JSON.stringify(deployment, null, 2)
    );
    
    console.log('\n=== Deployment Complete ===');
    console.log(JSON.stringify(deployment, null, 2));
    console.log('\n✅ Deployment saved to deployments/gnosis-vanity.json');
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
