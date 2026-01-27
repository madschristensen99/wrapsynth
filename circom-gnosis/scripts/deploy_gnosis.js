const hre = require("hardhat");
const fs = require("fs");
const path = require("path");
const axios = require("axios");

async function main() {
    console.log("🚀 Deploying WrappedMoneroV3 to Gnosis Chain\n");
    console.log("═".repeat(70));

    // Get deployer
    const [deployer] = await hre.ethers.getSigners();
    console.log("\n👤 Deployer:", deployer.address);
    
    // Check balance
    const balance = await hre.ethers.provider.getBalance(deployer.address);
    console.log("💰 Balance:", hre.ethers.formatEther(balance), "xDAI");
    
    if (balance === 0n) {
        console.error("\n❌ Deployer has no xDAI! Please fund the account first.");
        console.error("   Get xDAI from: https://gnosisfaucet.com/");
        process.exit(1);
    }

    // Get network info
    const network = await hre.ethers.provider.getNetwork();
    console.log("🌐 Network:", network.name);
    console.log("🔗 Chain ID:", network.chainId.toString());

    // Gnosis Chain addresses
    const WXDAI = "0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d";  // Wrapped xDAI
    const SDAI = "0xaf204776c7245bF4147c2612BF6e5972Ee483701";   // Savings xDAI (sDAI)
    const PYTH = "0x2880aB155794e7179c9eE2e38200202908C17B43";   // Pyth Oracle on Gnosis
    
    // Fetch current Monero block height
    console.log("\n🔍 Fetching current Monero block height...");
    const MONERO_RPC = process.env.MONERO_RPC_URL || "http://xmr.privex.io:18081";
    const response = await axios.post(MONERO_RPC + "/json_rpc", {
        jsonrpc: "2.0",
        id: "0",
        method: "get_last_block_header"
    });
    const INITIAL_MONERO_BLOCK = BigInt(response.data.result.block_header.height);
    console.log("✅ Current Monero block:", INITIAL_MONERO_BLOCK.toString());

    console.log("\n📋 Configuration:");
    console.log("   WxDAI:", WXDAI);
    console.log("   sDAI:", SDAI);
    console.log("   Pyth Oracle:", PYTH);
    console.log("   Initial Monero Block:", INITIAL_MONERO_BLOCK.toString());
    console.log("   Note: XMR price will be fetched from Pyth in constructor");

    // Deploy PlonkVerifier
    console.log("\n📝 Step 1: Deploying PlonkVerifier...");
    const PlonkVerifier = await hre.ethers.getContractFactory("PlonkVerifier");
    const verifier = await PlonkVerifier.deploy();
    await verifier.waitForDeployment();
    const verifierAddress = await verifier.getAddress();
    console.log("✅ PlonkVerifier deployed at:", verifierAddress);

    // Deploy WrappedMoneroV3
    console.log("\n📝 Step 2: Deploying WrappedMoneroV3...");
    const WrappedMoneroV3 = await hre.ethers.getContractFactory("WrappedMoneroV3");
    const bridge = await WrappedMoneroV3.deploy(
        verifierAddress,
        WXDAI,
        SDAI,
        PYTH,
        INITIAL_MONERO_BLOCK
    );
    await bridge.waitForDeployment();
    const bridgeAddress = await bridge.getAddress();
    console.log("✅ WrappedMoneroV3 deployed at:", bridgeAddress);

    // Save deployment info
    const deployment = {
        network: network.name,
        chainId: network.chainId.toString(),
        verifier: verifierAddress,
        bridge: bridgeAddress,
        oracle: deployer.address,
        deployedAt: new Date().toISOString()
    };

    const deploymentPath = path.join(__dirname, '../oracle/deployment.json');
    fs.writeFileSync(deploymentPath, JSON.stringify(deployment, null, 2));
    console.log("\n💾 Deployment info saved to:", deploymentPath);

    // Display summary
    console.log("\n" + "═".repeat(70));
    console.log("🎉 Deployment Complete!\n");
    console.log("📋 Contract Addresses:");
    console.log("   PlonkVerifier:", verifierAddress);
    console.log("   WrappedMoneroV3:", bridgeAddress);
    console.log("   Oracle:", deployer.address);
    console.log("\n📝 Next steps:");
    console.log("   1. Start oracle: node oracle/monero-oracle.js");
    console.log("   2. Generate witness: node scripts/generate_witness.js");
    console.log("   3. Generate DLEQ proof: node scripts/generate_dleq_proof.js");
    console.log("   4. Test mint: node scripts/test_mint.js");
    console.log("\n" + "═".repeat(70));
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error("\n❌ Deployment failed:", error);
        process.exit(1);
    });
