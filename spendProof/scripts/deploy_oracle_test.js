/**
 * Deploy MoneroBridge for Oracle Testing
 * 
 * Deploys MoneroBridge to local Hardhat network
 * Saves deployment info for oracle to use
 */

const { ethers } = require("hardhat");
const fs = require('fs');
const path = require('path');

async function main() {
    console.log("\n🚀 Deploying MoneroBridge for Oracle Testing...\n");
    
    const [deployer] = await ethers.getSigners();
    console.log(`Deployer: ${deployer.address}`);
    console.log(`Balance: ${ethers.formatEther(await ethers.provider.getBalance(deployer.address))} ETH\n`);
    
    // Deploy MockPlonkVerifier
    console.log("📦 Deploying MockPlonkVerifier...");
    const MockVerifier = await ethers.getContractFactory("MockPlonkVerifier");
    const verifier = await MockVerifier.deploy();
    await verifier.waitForDeployment();
    const verifierAddress = await verifier.getAddress();
    console.log(`   ✅ Deployed at: ${verifierAddress}\n`);
    
    // Deploy MoneroBridge
    console.log("📦 Deploying MoneroBridge...");
    const MoneroBridge = await ethers.getContractFactory("MoneroBridge");
    const bridge = await MoneroBridge.deploy(verifierAddress);
    await bridge.waitForDeployment();
    const bridgeAddress = await bridge.getAddress();
    console.log(`   ✅ Deployed at: ${bridgeAddress}\n`);
    
    // Verify oracle
    const oracleAddr = await bridge.oracle();
    console.log(`🔮 Oracle address: ${oracleAddr}`);
    console.log(`   (Should be deployer: ${oracleAddr === deployer.address ? '✅' : '❌'})\n`);
    
    // Save deployment info
    const deploymentInfo = {
        network: "localhost",
        chainId: (await ethers.provider.getNetwork()).chainId.toString(),
        verifier: verifierAddress,
        bridge: bridgeAddress,
        oracle: oracleAddr,
        deployedAt: new Date().toISOString()
    };
    
    const deploymentPath = path.join(__dirname, '../oracle/deployment.json');
    fs.writeFileSync(deploymentPath, JSON.stringify(deploymentInfo, null, 2));
    console.log(`💾 Deployment info saved to: ${deploymentPath}\n`);
    
    // Generate LP address for testing
    const A = "0x" + "a".repeat(64); // View key
    const B = "0x" + "b".repeat(64); // Spend key
    
    const lpAddress = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
            ['bytes32', 'bytes32'],
            [A, B]
        )
    );
    
    console.log("👤 Test LP Address:");
    console.log(`   View Key (A): ${A}`);
    console.log(`   Spend Key (B): ${B}`);
    console.log(`   LP Address: ${lpAddress}\n`);
    
    console.log("✅ Deployment complete!\n");
    console.log("📝 Next steps:");
    console.log("   1. Start oracle: node oracle/monero-oracle.js");
    console.log("   2. Send Monero to LP address (stagenet)");
    console.log("   3. Wait for oracle to post blocks");
    console.log("   4. Submit proof with transaction data\n");
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
