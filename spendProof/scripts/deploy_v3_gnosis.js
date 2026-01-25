const { ethers } = require("hardhat");
const axios = require("axios");

async function main() {
    console.log("\n🚀 Deploying WrappedMoneroV3 to Gnosis Chain\n");
    
    const [deployer] = await ethers.getSigners();
    console.log("Deployer:", deployer.address);
    
    const balance = await ethers.provider.getBalance(deployer.address);
    console.log("Balance:", ethers.formatEther(balance), "xDAI\n");
    
    // Gnosis Chain addresses
    const PYTH_GNOSIS = "0x2880aB155794e7179c9eE2e38200202908C17B43";
    const WXDAI = "0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d";
    const SDAI_GNOSIS = "0xaf204776c7245bF4147c2612BF6e5972Ee483701"; // Savings xDAI (Spark)
    
    // Deploy REAL PlonkVerifier
    console.log("📦 Deploying PlonkVerifier (REAL - from circuit)...");
    const PlonkVerifier = await ethers.getContractFactory("PlonkVerifier");
    const verifier = await PlonkVerifier.deploy();
    await verifier.waitForDeployment();
    const verifierAddress = await verifier.getAddress();
    console.log("✅ PlonkVerifier deployed:", verifierAddress);
    
    // Get initial XMR price from Pyth
    const XMR_USD_PRICE_ID = "0x46b8cc9347f04391764a0361e0b17c3ba394b001e7c304f7650f6376e37c321d";
    
    console.log("\n🌐 Fetching initial XMR price from Pyth...");
    const response = await axios.get(
        "https://hermes.pyth.network/v2/updates/price/latest",
        { params: { ids: [XMR_USD_PRICE_ID] } }
    );
    
    const priceData = response.data.parsed[0].price;
    const initialPrice = Number(priceData.price) * Math.pow(10, priceData.expo);
    const initialPriceWei = ethers.parseUnits(initialPrice.toFixed(2), 18);
    
    console.log("Initial XMR/USD Price: $" + initialPrice.toFixed(2));
    console.log("Price in Wei:", initialPriceWei.toString());
    
    // Get current Monero block
    console.log("\n🔍 Fetching current Monero block...");
    const moneroRpc = "http://xmr.privex.io:18081";
    const moneroResponse = await axios.post(moneroRpc + "/json_rpc", {
        jsonrpc: "2.0",
        id: "0",
        method: "get_last_block_header"
    });
    
    const currentMoneroBlock = moneroResponse.data.result.block_header.height;
    console.log("Current Monero block:", currentMoneroBlock);
    
    // Deploy WrappedMoneroV3
    console.log("\n📦 Deploying WrappedMoneroV3...");
    const WrappedMoneroV3 = await ethers.getContractFactory("WrappedMoneroV3");
    const wrappedMonero = await WrappedMoneroV3.deploy(
        verifierAddress,
        WXDAI,
        SDAI_GNOSIS,
        PYTH_GNOSIS,
        initialPriceWei,
        currentMoneroBlock
    );
    
    console.log("⏳ Waiting for deployment...");
    await wrappedMonero.waitForDeployment();
    
    const wmAddress = await wrappedMonero.getAddress();
    console.log("\n✅ WrappedMoneroV3 deployed successfully!");
    console.log("Contract address:", wmAddress);
    console.log("\nView on GnosisScan:");
    console.log("https://gnosisscan.io/address/" + wmAddress);
    
    console.log("\n📋 Deployment Summary:");
    console.log("═══════════════════════════════════════════════════════");
    console.log("Network: Gnosis Chain");
    console.log("WrappedMoneroV3:", wmAddress);
    console.log("PlonkVerifier (REAL):", verifierAddress);
    console.log("Pyth Oracle:", PYTH_GNOSIS);
    console.log("WxDAI:", WXDAI);
    console.log("sDAI:", SDAI_GNOSIS);
    console.log("Initial XMR Price: $" + initialPrice.toFixed(2));
    console.log("═══════════════════════════════════════════════════════");
    
    console.log("\n🎯 Key Features:");
    console.log("✅ Per-LP architecture with custom fees");
    console.log("✅ Merkle proof verification for Monero data");
    console.log("✅ Pyth oracle for decentralized XMR/USD prices");
    console.log("✅ Oracle earns ALL sDAI yield");
    console.log("✅ 2-hour burn window with LP fulfillment");
    console.log("✅ 150% safe ratio, 120% liquidation threshold");
    console.log("✅ REAL PLONK verifier (1,167 constraints)");
    
    // Save deployment info
    const fs = require('fs');
    const deploymentInfo = {
        network: "gnosis",
        wrappedMoneroV3: wmAddress,
        verifier: verifierAddress,
        pythOracle: PYTH_GNOSIS,
        wxdai: WXDAI,
        sdai: SDAI_GNOSIS,
        initialPrice: initialPrice,
        deployer: deployer.address,
        timestamp: new Date().toISOString(),
        blockNumber: await ethers.provider.getBlockNumber(),
        circuitConstraints: 1167,
        features: {
            perLPArchitecture: true,
            merkleProofs: true,
            pythOracle: true,
            oracleYield: true,
            realPlonkVerifier: true
        }
    };
    
    fs.writeFileSync(
        'deployments/wrapped_monero_v3_gnosis.json',
        JSON.stringify(deploymentInfo, null, 2)
    );
    console.log("\n💾 Deployment info saved to: deployments/wrapped_monero_v3_gnosis.json");
    
    console.log("\n🎉 Deployment complete! Next steps:");
    console.log("1. Verify contracts on GnosisScan");
    console.log("2. Register as LP: wrappedMonero.registerLP(mintFeeBps, burnFeeBps, true)");
    console.log("3. Deposit collateral: wrappedMonero.lpDeposit(daiAmount)");
    console.log("4. Post Monero blocks: wrappedMonero.postMoneroBlock(...)");
    console.log("5. Test minting with real Monero transactions");
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
