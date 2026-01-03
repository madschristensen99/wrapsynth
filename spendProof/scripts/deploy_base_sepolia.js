const hre = require("hardhat");
const fs = require("fs");

async function main() {
    console.log("🚀 Deploying Monero Bridge DLEQ to Base Sepolia...\n");

    const [deployer] = await hre.ethers.getSigners();
    console.log("Deploying with account:", deployer.address);
    console.log("Account balance:", (await hre.ethers.provider.getBalance(deployer.address)).toString());

    // Deploy PlonkVerifier
    console.log("\n📝 Step 1: Deploying PlonkVerifier...");
    const PlonkVerifier = await hre.ethers.getContractFactory("PlonkVerifier");
    const verifier = await PlonkVerifier.deploy();
    await verifier.waitForDeployment();
    const verifierAddress = await verifier.getAddress();
    console.log("✅ PlonkVerifier deployed to:", verifierAddress);

    // Deploy MoneroBridgeDLEQ (with PLONK support)
    console.log("\n📝 Step 2: Deploying MoneroBridgeDLEQ...");
    const MoneroBridgeDLEQ = await hre.ethers.getContractFactory("MoneroBridgeDLEQ");
    const bridge = await MoneroBridgeDLEQ.deploy(verifierAddress);
    await bridge.waitForDeployment();
    const bridgeAddress = await bridge.getAddress();
    console.log("✅ MoneroBridgeDLEQ deployed to:", bridgeAddress);

    // Save deployment addresses
    const deployment = {
        network: "baseSepolia",
        chainId: 84532,
        deployer: deployer.address,
        contracts: {
            PlonkVerifier: verifierAddress,
            MoneroBridgeDLEQ: bridgeAddress
        },
        timestamp: new Date().toISOString()
    };

    fs.writeFileSync(
        'deployment_base_sepolia.json',
        JSON.stringify(deployment, null, 2)
    );

    console.log("\n" + "═".repeat(70));
    console.log("🎉 DEPLOYMENT COMPLETE!");
    console.log("═".repeat(70));
    console.log("\n📋 Contract Addresses:");
    console.log("   PlonkVerifier:", verifierAddress);
    console.log("   MoneroBridgeDLEQ:", bridgeAddress);
    console.log("\n💾 Deployment info saved to: deployment_base_sepolia.json");
    console.log("\n🔍 Verify contracts:");
    console.log(`   npx hardhat verify --network baseSepolia ${verifierAddress}`);
    console.log(`   npx hardhat verify --network baseSepolia ${bridgeAddress} ${verifierAddress}`);
    console.log("\n🌐 View on BaseScan:");
    console.log(`   https://sepolia.basescan.org/address/${bridgeAddress}`);
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
