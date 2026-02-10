#!/usr/bin/env node

/**
 * Deploy PrivacySwapHook via Factory with CREATE2
 */

const hre = require("hardhat");
const fs = require('fs');
const path = require('path');

async function main() {
    console.log("\n🏭 Deploying PrivacySwapHook via Factory\n");
    console.log("═".repeat(70));
    
    const [deployer] = await hre.ethers.getSigners();
    console.log("\nDeployer:", deployer.address);
    console.log("Balance:", hre.ethers.formatEther(await hre.ethers.provider.getBalance(deployer.address)), "ETH\n");
    
    const POOL_MANAGER = "0x00b036b58a818b1bc34d502d3fe730db729e62ac";
    const WRAPPED_MONERO = "0x1aFE6c215A3b7136dA30c405C436f668f3dec4BA";
    const MINT_RELAYER = "0xbF9Aff472b81D36971b3328f79fA661610fE8675";
    
    // Step 1: Deploy Factory
    console.log("[1/3] Deploying PrivacySwapHookFactory...");
    const Factory = await hre.ethers.getContractFactory("PrivacySwapHookFactory");
    const factory = await Factory.deploy();
    await factory.waitForDeployment();
    const factoryAddress = await factory.getAddress();
    console.log("✓ Factory deployed to:", factoryAddress);
    console.log("");
    
    // Step 2: Mine for valid salt (off-chain)
    console.log("[2/3] Mining for valid salt...");
    // Hook permission flags (from Hooks.sol)
    // BEFORE_SWAP_FLAG = 1 << 7 = 0x80
    // AFTER_SWAP_FLAG = 1 << 6 = 0x40
    // All other flags should be 0
    const BEFORE_SWAP_FLAG = BigInt(1) << BigInt(7);
    const AFTER_SWAP_FLAG = BigInt(1) << BigInt(6);
    const requiredFlags = BEFORE_SWAP_FLAG | AFTER_SWAP_FLAG; // 0xC0
    
    // Get bytecode hash for CREATE2 calculation
    const PrivacySwapHook = await hre.ethers.getContractFactory("PrivacySwapHook");
    const bytecodeHash = hre.ethers.keccak256(hre.ethers.concat([
        PrivacySwapHook.bytecode,
        hre.ethers.AbiCoder.defaultAbiCoder().encode(
            ["address", "address", "address"],
            [POOL_MANAGER, WRAPPED_MONERO, MINT_RELAYER]
        )
    ]));
    
    let salt = 0;
    let found = false;
    let predictedAddress;
    const startTime = Date.now();
    
    while (!found && salt < 100000) {
        const saltHex = hre.ethers.zeroPadValue(hre.ethers.toBeHex(salt), 32);
        
        // Compute CREATE2 address
        predictedAddress = hre.ethers.getCreate2Address(
            factoryAddress,
            saltHex,
            bytecodeHash
        );
        
        // Check if address has exactly the required permission bits
        const addressBigInt = BigInt(predictedAddress);
        const addressFlags = addressBigInt & BigInt(0x3FFF); // Mask for 14 permission bits (bits 0-13)
        
        if (addressFlags === requiredFlags) {
            found = true;
            console.log("✅ Found valid salt!");
            console.log("   Salt:", salt);
            console.log("   Address:", predictedAddress);
            console.log("   Attempts:", salt + 1);
            console.log("   Time:", ((Date.now() - startTime) / 1000).toFixed(2), "seconds");
            console.log("");
            
            // Step 3: Deploy Hook
            console.log("[3/3] Deploying PrivacySwapHook...");
            const tx = await factory.deployHook(
                salt,
                POOL_MANAGER,
                WRAPPED_MONERO,
                MINT_RELAYER
            );
            
            console.log("   TX hash:", tx.hash);
            const receipt = await tx.wait();
            console.log("   Gas used:", receipt.gasUsed.toString());
            
            // Get deployed address from event
            const event = receipt.logs.find(log => {
                try {
                    return factory.interface.parseLog(log).name === 'HookDeployed';
                } catch {
                    return false;
                }
            });
            
            const hookAddress = event ? factory.interface.parseLog(event).args.hook : predictedAddress;
            
            console.log("\n✅ SUCCESS!");
            console.log("   Hook deployed to:", hookAddress);
            console.log("");
            
            // Verify address
            if (hookAddress.toLowerCase() !== predictedAddress.toLowerCase()) {
                console.error("⚠️  WARNING: Deployed address doesn't match predicted!");
                console.error("   Predicted:", predictedAddress);
                console.error("   Actual:", hookAddress);
            } else {
                console.log("✅ Address verification passed!");
            }
            
            // Update deployment file
            const deploymentPath = path.join(__dirname, '../deployments/unichain_testnet_latest.json');
            const deployment = JSON.parse(fs.readFileSync(deploymentPath, 'utf8'));
            deployment.contracts.PrivacySwapHookFactory = factoryAddress;
            deployment.contracts.PrivacySwapHook = hookAddress;
            deployment.timestamp = new Date().toISOString();
            fs.writeFileSync(deploymentPath, JSON.stringify(deployment, null, 2));
            
            console.log("\n💾 Deployment file updated");
            console.log("\n" + "═".repeat(70));
            console.log("✓ Deployment Complete!");
            console.log("═".repeat(70));
            
            console.log("\n📊 Deployed Contracts:");
            console.log("   Factory:", factoryAddress);
            console.log("   Hook:", hookAddress);
            
            console.log("\n🔗 Block Explorer:");
            console.log(`   Factory: https://sepolia.uniscan.xyz/address/${factoryAddress}`);
            console.log(`   Hook: https://sepolia.uniscan.xyz/address/${hookAddress}\n`);
            
            return;
        }
        
        salt++;
        
        if (salt % 1000 === 0) {
            process.stdout.write(`   Tried ${salt} salts...\r`);
        }
    }
    
    if (!found) {
        console.error("\n❌ Failed to find valid salt after", salt, "attempts");
        process.exit(1);
    }
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
