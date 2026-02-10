const { ethers } = require("hardhat");
const fs = require("fs");

async function main() {
    console.log("📝 Registering as a Relayer\n");

    // Load deployment
    const deploymentPath = "./deployments/localhost/deployment.json";
    if (!fs.existsSync(deploymentPath)) {
        console.error("❌ Deployment file not found. Deploy contracts first.");
        process.exit(1);
    }

    const deployment = JSON.parse(fs.readFileSync(deploymentPath, "utf8"));
    const relayerAddress = deployment.mintRelayer;

    console.log("📋 MintRelayer:", relayerAddress);

    // Get signer (use account 3 as relayer)
    const [deployer, lp, user, relayer] = await ethers.getSigners();
    console.log("👤 Relayer address:", relayer.address);
    console.log("💰 Balance:", ethers.formatEther(await ethers.provider.getBalance(relayer.address)), "ETH\n");

    // Get contract
    const mintRelayerContract = await ethers.getContractAt("MintRelayer", relayerAddress, relayer);

    // Check if already registered
    const currentStake = await mintRelayerContract.relayerStakes(relayer.address);
    if (currentStake > 0) {
        console.log(`✅ Already registered with ${ethers.formatEther(currentStake)} ETH stake`);
        return;
    }

    // Get minimum stake
    const minStake = await mintRelayerContract.minRelayerStake();
    console.log(`📊 Minimum stake: ${ethers.formatEther(minStake)} ETH`);

    // Register with stake
    const stakeAmount = minStake; // Use minimum stake
    console.log(`\n💸 Registering with ${ethers.formatEther(stakeAmount)} ETH stake...`);

    const tx = await mintRelayerContract.registerRelayer({
        value: stakeAmount
    });
    console.log("   TX:", tx.hash);
    
    await tx.wait();
    console.log("✅ Relayer registered successfully!");

    // Verify registration
    const isAuthorized = await mintRelayerContract.isAuthorizedRelayer(relayer.address);
    console.log("\n📊 Relayer Status:");
    console.log(`   Authorized: ${isAuthorized}`);
    console.log(`   Stake: ${ethers.formatEther(await mintRelayerContract.relayerStakes(relayer.address))} ETH`);

    console.log("\n✅ You can now run the relayer service!");
    console.log("   npx hardhat run scripts/relayer/startRelayer.js\n");
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
