#!/usr/bin/env node

/**
 * Deploy PrivacySwapHook to Uniswap v4
 */

const hre = require("hardhat");
const fs = require('fs');
const path = require('path');

async function main() {
    console.log("\n🚀 Deploying PrivacySwapHook\n");
    console.log("═".repeat(70));
    
    const [deployer] = await hre.ethers.getSigners();
    console.log("\nDeploying with account:", deployer.address);
    console.log("Account balance:", hre.ethers.formatEther(await hre.ethers.provider.getBalance(deployer.address)), "ETH\n");
    
    // Load existing deployment
    const deploymentPath = path.join(__dirname, '../deployments/unichain_testnet_latest.json');
    const deployment = JSON.parse(fs.readFileSync(deploymentPath, 'utf8'));
    
    console.log("📋 Existing Contracts:");
    console.log("   WrappedMonero:", deployment.contracts.WrappedMonero);
    console.log("   MintRelayer:", deployment.contracts.MintRelayer);
    console.log("");
    
    // Uniswap v4 PoolManager address (Unichain Sepolia)
    // Source: https://docs.uniswap.org/contracts/v4/deployments
    const POOL_MANAGER = "0x00b036b58a818b1bc34d502d3fe730db729e62ac";
    
    console.log("[1/1] Deploying PrivacySwapHook...");
    console.log("   Constructor args:");
    console.log("     PoolManager:", POOL_MANAGER);
    console.log("     WrappedMonero:", deployment.contracts.WrappedMonero);
    console.log("     MintRelayer:", deployment.contracts.MintRelayer);
    console.log("");
    
    try {
        const PrivacySwapHook = await hre.ethers.getContractFactory("PrivacySwapHook");
        const hook = await PrivacySwapHook.deploy(
            POOL_MANAGER,
            deployment.contracts.WrappedMonero,
            deployment.contracts.MintRelayer
        );
        
        await hook.waitForDeployment();
        const hookAddress = await hook.getAddress();
        
        console.log("✓ PrivacySwapHook deployed to:", hookAddress);
    } catch (error) {
        console.error("\n❌ Deployment failed:");
        console.error("   Error:", error.message);
        if (error.data) {
            console.error("   Data:", error.data);
        }
        console.error("\n   Note: Uniswap v4 hooks require specific address prefixes.");
        console.error("   The hook address must match the permissions bitmap.");
        console.error("   This requires using CREATE2 with salt mining.");
        console.error("\n   For now, the PrivacySwapHook contract is ready but not deployed.");
        console.error("   It will be deployed when CREATE2 deployment is implemented.");
        process.exit(1);
    }

    
    // Update deployment file
    deployment.contracts.PrivacySwapHook = hookAddress;
    deployment.timestamp = new Date().toISOString();
    
    fs.writeFileSync(deploymentPath, JSON.stringify(deployment, null, 2));
    console.log("💾 Deployment updated:", deploymentPath);
    
    console.log("\n" + "═".repeat(70));
    console.log("✓ Deployment Complete!");
    console.log("═".repeat(70));
    
    console.log("\n📊 Deployed Contracts:");
    console.log("   WrappedMonero:", deployment.contracts.WrappedMonero);
    console.log("   MintRelayer:", deployment.contracts.MintRelayer);
    console.log("   PrivacySwapHook:", hookAddress);
    
    console.log("\n📚 Next Steps:");
    console.log("   1. Create wXMR/TOKEN pools on Uniswap v4");
    console.log("   2. Register hook with pool");
    console.log("   3. Test privacy swap flow");
    console.log("   4. Verify contract:");
    console.log(`      npx hardhat verify --network unichain_testnet ${hookAddress} ${POOL_MANAGER} ${deployment.contracts.WrappedMonero} ${deployment.contracts.MintRelayer}`);
    
    console.log("\n🔗 Block Explorer:");
    console.log(`   https://unichain-sepolia.blockscout.com/address/${hookAddress}\n`);
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
