const { ethers } = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
    console.log("🚀 Deploying MintRelayer Contract\n");

    const [deployer] = await ethers.getSigners();
    const network = await ethers.provider.getNetwork();
    
    console.log("Deploying with account:", deployer.address);
    console.log("Network:", network.name, "(Chain ID:", network.chainId.toString(), ")");
    console.log("Account balance:", ethers.formatEther(await ethers.provider.getBalance(deployer.address)), "ETH\n");

    // Determine deployment file based on network
    let deploymentFile;
    if (network.chainId === 1301n) {
        deploymentFile = "./deployments/unichain_testnet_latest.json";
    } else if (network.chainId === 31337n) {
        deploymentFile = "./deployments/localhost/deployment.json";
    } else {
        deploymentFile = `./deployments/${network.name}_latest.json`;
    }
    
    let deployment = {};
    if (fs.existsSync(deploymentFile)) {
        deployment = JSON.parse(fs.readFileSync(deploymentFile, "utf8"));
        const wrappedMoneroAddress = deployment.contracts?.WrappedMonero || deployment.wrappedMonero;
        console.log("📋 Loaded existing deployment");
        console.log(`   WrappedMonero: ${wrappedMoneroAddress}\n`);
        
        if (!wrappedMoneroAddress) {
            console.error("❌ WrappedMonero not found in deployment. Deploy it first.");
            process.exit(1);
        }
        
        deployment.wrappedMonero = wrappedMoneroAddress;
    } else {
        console.error("❌ Deployment file not found:", deploymentFile);
        console.error("   Deploy WrappedMonero first.");
        process.exit(1);
    }

    // Deploy MintRelayer
    console.log("📝 Deploying MintRelayer...");
    const MintRelayer = await ethers.getContractFactory("MintRelayer");
    const mintRelayer = await MintRelayer.deploy(deployment.wrappedMonero);
    await mintRelayer.waitForDeployment();
    const mintRelayerAddress = await mintRelayer.getAddress();

    console.log("✅ MintRelayer deployed to:", mintRelayerAddress);
    
    // Wait for a few confirmations on testnet
    if (network.chainId !== 31337n) {
        console.log("⏳ Waiting for confirmations...");
        await mintRelayer.deploymentTransaction().wait(3);
        console.log("✅ Confirmed!");
    }

    // Update deployment file
    if (!deployment.contracts) {
        deployment.contracts = {};
    }
    deployment.contracts.MintRelayer = mintRelayerAddress;
    deployment.mintRelayerDeployedAt = new Date().toISOString();
    
    const deploymentDir = path.dirname(deploymentFile);
    if (!fs.existsSync(deploymentDir)) {
        fs.mkdirSync(deploymentDir, { recursive: true });
    }
    fs.writeFileSync(deploymentFile, JSON.stringify(deployment, null, 2));
    
    console.log("\n💾 Deployment saved to:", deploymentFile);

    // Display configuration
    console.log("\n⚙️  MintRelayer Configuration:");
    const relayerFeeBps = await mintRelayer.relayerFeeBps();
    console.log(`   Relayer Fee: ${relayerFeeBps} bps (${Number(relayerFeeBps) / 100}%)`);
    console.log(`   Min Relayer Stake: ${ethers.formatEther(await mintRelayer.minRelayerStake())} ETH`);
    console.log(`   Permissionless Mode: ${await mintRelayer.permissionlessMode()}`);
    console.log(`   Owner: ${await mintRelayer.owner()}`);

    console.log("\n📚 Next Steps:");
    if (network.chainId === 1301n) {
        console.log("   1. Verify contract: npx hardhat verify --network unichain_testnet", mintRelayerAddress, deployment.wrappedMonero);
        console.log("   2. Register as a relayer: npx hardhat run scripts/relayer/registerRelayer.js --network unichain_testnet");
        console.log("   3. Create private mint intent: npx hardhat run scripts/relayer/privateMint.js --network unichain_testnet");
    } else {
        console.log("   1. Register as a relayer: npx hardhat run scripts/relayer/registerRelayer.js");
        console.log("   2. Create private mint intent: npx hardhat run scripts/relayer/privateMint.js");
        console.log("   3. Start relayer service: npx hardhat run scripts/relayer/startRelayer.js");
    }
    
    console.log("\n✅ Deployment complete!\n");
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
