const hre = require('hardhat');
const { ethers } = hre;
const fs = require('fs');

async function main() {
    const [deployer] = await ethers.getSigners();
    
    console.log('🚀 Deploying WrappedMoneroV3 (Fixed)\n');
    console.log('Deployer:', deployer.address);
    console.log('Balance:', ethers.formatEther(await ethers.provider.getBalance(deployer.address)), 'xDAI\n');
    
    // Deploy REAL PlonkVerifier
    console.log('📝 Deploying PlonkVerifier...');
    const PlonkVerifier = await ethers.getContractFactory('PlonkVerifier');
    const verifier = await PlonkVerifier.deploy();
    await verifier.waitForDeployment();
    console.log('✅ PlonkVerifier:', await verifier.getAddress());
    console.log();
    
    // Get existing contract addresses
    const PYTH = '0x2880aB155794e7179c9eE2e38200202908C17B43';
    const WXDAI = '0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d';
    const SDAI = '0xaf204776c7245bF4147c2612BF6e5972Ee483701';
    
    // Deploy WrappedMoneroV3
    console.log('📝 Deploying WrappedMoneroV3...');
    const WrappedMoneroV3 = await ethers.getContractFactory('WrappedMoneroV3');
    const wrappedMonero = await WrappedMoneroV3.deploy(
        await verifier.getAddress(),
        WXDAI,
        SDAI,
        PYTH,
        ethers.parseUnits('180', 18), // Initial XMR price $180
        3595017  // Latest Monero block
    );
    await wrappedMonero.waitForDeployment();
    const wrappedMoneroAddress = await wrappedMonero.getAddress();
    console.log('✅ WrappedMoneroV3:', wrappedMoneroAddress);
    console.log();
    
    // Register as LP
    console.log('📝 Registering as LP...');
    const tx1 = await wrappedMonero.registerLP(
        50,    // 0.5% mint fee
        50,    // 0.5% burn fee
        10,    // max 10 pending intents
        true   // active
    );
    await tx1.wait();
    console.log('✅ LP registered');
    console.log();
    
    // Deposit collateral
    console.log('📝 Depositing 2 xDAI collateral...');
    const wxdai = await ethers.getContractAt('IERC20', WXDAI);
    const depositAmount = ethers.parseEther('2');
    
    const tx2 = await wxdai.approve(wrappedMoneroAddress, depositAmount);
    await tx2.wait();
    
    const tx3 = await wrappedMonero.lpDeposit(depositAmount);
    await tx3.wait();
    console.log('✅ Collateral deposited');
    console.log();
    
    // Save deployment info
    const deployment = {
        network: 'gnosis',
        deployer: deployer.address,
        timestamp: new Date().toISOString(),
        contracts: {
            WrappedMoneroV3: wrappedMoneroAddress,
            PlonkVerifier: await verifier.getAddress(),
            Pyth: PYTH,
            WxDAI: WXDAI,
            sDAI: SDAI
        }
    };
    
    fs.writeFileSync('deployment_v3_fixed.json', JSON.stringify(deployment, null, 2));
    console.log('💾 Deployment info saved to deployment_v3_fixed.json');
    console.log();
    console.log('🎉 Deployment complete!');
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
