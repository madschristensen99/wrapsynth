const { ethers } = require("hardhat");

async function main() {
    console.log("\n🚀 Deploying PythPriceConsumer to Gnosis Chain\n");
    
    const [deployer] = await ethers.getSigners();
    console.log("Deployer address:", deployer.address);
    
    const balance = await ethers.provider.getBalance(deployer.address);
    console.log("Deployer balance:", ethers.formatEther(balance), "xDAI");
    
    if (balance === 0n) {
        console.error("\n❌ Error: Deployer has no xDAI balance!");
        console.error("Please fund your wallet with xDAI on Gnosis Chain");
        console.error("Get xDAI from: https://gnosisfaucet.com or bridge at https://bridge.gnosischain.com");
        process.exit(1);
    }
    
    // Pyth contract address on Gnosis Chain
    const PYTH_CONTRACT_GNOSIS = "0x2880aB155794e7179c9eE2e38200202908C17B43";
    
    console.log("\n📦 Deploying PythPriceConsumer...");
    console.log("Pyth Oracle Address:", PYTH_CONTRACT_GNOSIS);
    
    const PythPriceConsumer = await ethers.getContractFactory("PythPriceConsumer");
    const pythConsumer = await PythPriceConsumer.deploy(PYTH_CONTRACT_GNOSIS);
    
    console.log("\n⏳ Waiting for deployment...");
    await pythConsumer.waitForDeployment();
    
    const address = await pythConsumer.getAddress();
    console.log("\n✅ PythPriceConsumer deployed successfully!");
    console.log("Contract address:", address);
    console.log("\nView on GnosisScan:");
    console.log("https://gnosisscan.io/address/" + address);
    
    console.log("\n📋 Contract Info:");
    console.log("═══════════════════════════════════════════════════════");
    console.log("Network: Gnosis Chain");
    console.log("Contract: PythPriceConsumer");
    console.log("Address:", address);
    console.log("Pyth Oracle:", PYTH_CONTRACT_GNOSIS);
    console.log("\nSupported Price Feeds:");
    console.log("  XMR/USD: 0x46b8cc9347f04391764a0361e0b17c3ba394b001e7c304f7650f6376e37c321d");
    console.log("  ETH/USD: 0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace");
    console.log("  BTC/USD: 0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43");
    console.log("═══════════════════════════════════════════════════════");
    
    // Save deployment info
    const fs = require('fs');
    const deploymentInfo = {
        network: "gnosis",
        contractName: "PythPriceConsumer",
        address: address,
        pythOracle: PYTH_CONTRACT_GNOSIS,
        deployer: deployer.address,
        timestamp: new Date().toISOString(),
        blockNumber: await ethers.provider.getBlockNumber()
    };
    
    fs.writeFileSync(
        'deployments/pyth_gnosis.json',
        JSON.stringify(deploymentInfo, null, 2)
    );
    console.log("\n💾 Deployment info saved to: deployments/pyth_gnosis.json");
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
