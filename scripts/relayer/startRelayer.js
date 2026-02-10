const { ethers } = require("hardhat");
const fs = require("fs");
const RelayerService = require("./relayerService");

async function main() {
    console.log("🚀 Starting Relayer Service\n");

    // Load deployment
    const deploymentPath = "./deployments/localhost/deployment.json";
    if (!fs.existsSync(deploymentPath)) {
        console.error("❌ Deployment file not found. Deploy contracts first.");
        process.exit(1);
    }

    const deployment = JSON.parse(fs.readFileSync(deploymentPath, "utf8"));
    const relayerAddress = deployment.mintRelayer;
    const wrappedMoneroAddress = deployment.wrappedMonero;

    console.log("📋 Contract Addresses:");
    console.log(`   MintRelayer: ${relayerAddress}`);
    console.log(`   WrappedMonero: ${wrappedMoneroAddress}\n`);

    // Get relayer signer (account 3)
    const [deployer, lp, user, relayer] = await ethers.getSigners();
    console.log("👤 Relayer wallet:", relayer.address);

    // Check if registered
    const mintRelayerContract = await ethers.getContractAt("MintRelayer", relayerAddress, relayer);
    const isAuthorized = await mintRelayerContract.isAuthorizedRelayer(relayer.address);
    
    if (!isAuthorized) {
        console.error("❌ Relayer not authorized. Register first:");
        console.error("   npx hardhat run scripts/relayer/registerRelayer.js");
        process.exit(1);
    }

    console.log("✅ Relayer authorized\n");

    // Initialize relayer service
    const relayerService = new RelayerService({
        relayerAddress,
        wrappedMoneroAddress,
        relayerWallet: relayer,
        intentQueueFile: "./relayer-queue.json",
        pollInterval: 10000 // 10 seconds
    });

    await relayerService.init();

    // Display current queue status
    const status = relayerService.getStatus();
    console.log("\n📊 Queue Status:");
    console.log(`   Total: ${status.total}`);
    console.log(`   Pending: ${status.pending}`);
    console.log(`   Completed: ${status.completed}`);
    console.log(`   Failed: ${status.failed}`);
    console.log(`   Expired: ${status.expired}\n`);

    // Handle graceful shutdown
    process.on('SIGINT', () => {
        console.log("\n\n🛑 Received SIGINT, shutting down gracefully...");
        relayerService.stop();
        process.exit(0);
    });

    process.on('SIGTERM', () => {
        console.log("\n\n🛑 Received SIGTERM, shutting down gracefully...");
        relayerService.stop();
        process.exit(0);
    });

    // Start service
    console.log("🔄 Monitoring for intents...");
    console.log("   Press Ctrl+C to stop\n");
    
    await relayerService.start();
}

main()
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
