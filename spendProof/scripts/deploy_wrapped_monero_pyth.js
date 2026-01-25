const { ethers } = require("hardhat");

async function main() {
    console.log("\n🚀 Deploying WrappedMoneroPyth to Gnosis Chain\n");
    
    const [deployer] = await ethers.getSigners();
    console.log("Deployer:", deployer.address);
    
    const balance = await ethers.provider.getBalance(deployer.address);
    console.log("Balance:", ethers.formatEther(balance), "xDAI\n");
    
    // Gnosis Chain addresses
    const PYTH_GNOSIS = "0x2880aB155794e7179c9eE2e38200202908C17B43";
    const WXDAI = "0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d"; // Wrapped xDAI
    const SDAI_GNOSIS = "0xaf204776c7245bF4147c2612BF6e5972Ee483701"; // Savings xDAI (Spark)
    
    // Deploy REAL PlonkVerifier
    console.log("📦 Deploying PlonkVerifier (REAL ZK verifier)...");
    const PlonkVerifier = await ethers.getContractFactory("PlonkVerifier");
    const verifier = await PlonkVerifier.deploy();
    await verifier.waitForDeployment();
    const verifierAddress = await verifier.getAddress();
    console.log("✅ PlonkVerifier deployed:", verifierAddress);
    
    // Get initial XMR price from Pyth
    const axios = require("axios");
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
    
    // Deploy WrappedMoneroPyth
    console.log("\n📦 Deploying WrappedMoneroPyth...");
    const WrappedMoneroPyth = await ethers.getContractFactory("WrappedMoneroPyth");
    const wrappedMonero = await WrappedMoneroPyth.deploy(
        verifierAddress,
        WXDAI,
        SDAI_GNOSIS,
        PYTH_GNOSIS,
        initialPriceWei
    );
    
    console.log("⏳ Waiting for deployment...");
    await wrappedMonero.waitForDeployment();
    
    const wmAddress = await wrappedMonero.getAddress();
    console.log("\n✅ WrappedMoneroPyth deployed successfully!");
    console.log("Contract address:", wmAddress);
    console.log("\nView on GnosisScan:");
    console.log("https://gnosisscan.io/address/" + wmAddress);
    
    console.log("\n📋 Deployment Summary:");
    console.log("═══════════════════════════════════════════════════════");
    console.log("Network: Gnosis Chain");
    console.log("WrappedMoneroPyth:", wmAddress);
    console.log("PlonkVerifier:", verifierAddress);
    console.log("Pyth Oracle:", PYTH_GNOSIS);
    console.log("WxDAI:", WXDAI);
    console.log("sDAI:", SDAI_GNOSIS);
    console.log("Initial XMR Price: $" + initialPrice.toFixed(2));
    console.log("═══════════════════════════════════════════════════════");
    
    // Save deployment info
    const fs = require('fs');
    const deploymentInfo = {
        network: "gnosis",
        wrappedMonero: wmAddress,
        verifier: verifierAddress,
        pythOracle: PYTH_GNOSIS,
        wxdai: WXDAI,
        sdai: SDAI_GNOSIS,
        initialPrice: initialPrice,
        deployer: deployer.address,
        timestamp: new Date().toISOString(),
        blockNumber: await ethers.provider.getBlockNumber()
    };
    
    fs.writeFileSync(
        'deployments/wrapped_monero_pyth_gnosis.json',
        JSON.stringify(deploymentInfo, null, 2)
    );
    console.log("\n💾 Deployment info saved to: deployments/wrapped_monero_pyth_gnosis.json");
    
    console.log("\n🎉 Deployment complete! Next steps:");
    console.log("1. Test minting with: npx hardhat run scripts/test_mint_pyth.js --network gnosis");
    console.log("2. Verify contract on GnosisScan");
    console.log("3. Set up oracle to post Monero block data");
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
