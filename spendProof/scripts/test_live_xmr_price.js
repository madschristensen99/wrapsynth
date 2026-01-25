const { ethers } = require("hardhat");
const axios = require("axios");

async function main() {
    console.log("\n🌐 Testing LIVE XMR Price on Real Gnosis Chain\n");
    
    // Your deployed contract address
    const CONTRACT_ADDRESS = "0x8652eaDC52Cf494B8cDAc413951Ae71277F31708";
    const XMR_USD_PRICE_ID = "0x46b8cc9347f04391764a0361e0b17c3ba394b001e7c304f7650f6376e37c321d";
    
    const [deployer] = await ethers.getSigners();
    console.log("Wallet:", deployer.address);
    
    // Connect to deployed contract
    const pythConsumer = await ethers.getContractAt("PythPriceConsumer", CONTRACT_ADDRESS);
    console.log("Contract:", CONTRACT_ADDRESS);
    console.log("Network: Gnosis Chain (LIVE)");
    
    // Fetch latest XMR price from Hermes
    console.log("\n🌐 Fetching latest XMR price from Pyth Hermes...");
    const response = await axios.get(
        "https://hermes.pyth.network/v2/updates/price/latest",
        { params: { ids: [XMR_USD_PRICE_ID] } }
    );
    
    if (response.data.parsed && response.data.parsed.length > 0) {
        const priceData = response.data.parsed[0].price;
        const price = Number(priceData.price) * Math.pow(10, priceData.expo);
        console.log("✅ Hermes API Price: $" + price.toFixed(2));
    }
    
    // Update on-chain price
    console.log("\n🔄 Updating XMR price on-chain...");
    const priceUpdateData = response.data.binary.data.map(d => "0x" + d);
    const fee = await pythConsumer.getUpdateFee(priceUpdateData);
    console.log("Update fee:", ethers.formatEther(fee), "xDAI");
    
    const tx = await pythConsumer.updatePriceFeeds(priceUpdateData, { value: fee });
    console.log("Transaction submitted:", tx.hash);
    console.log("Waiting for confirmation...");
    
    const receipt = await tx.wait();
    console.log("✅ Confirmed in block:", receipt.blockNumber);
    console.log("View on GnosisScan: https://gnosisscan.io/tx/" + tx.hash);
    
    // Read the updated price from contract
    console.log("\n📊 Reading XMR price from on-chain contract...");
    const [price, expo, timestamp] = await pythConsumer.getXMRPrice();
    const humanPrice = Number(price) * Math.pow(10, Number(expo));
    
    console.log("\n╔════════════════════════════════════════╗");
    console.log("║   LIVE XMR/USD PRICE (Gnosis Chain)   ║");
    console.log("╠════════════════════════════════════════╣");
    console.log("║  Price: $" + humanPrice.toFixed(2).padEnd(30) + "║");
    console.log("║  Time:  " + new Date(Number(timestamp) * 1000).toISOString().padEnd(26) + "║");
    console.log("╚════════════════════════════════════════╝");
    
    // Get price with confidence
    const [priceConf, conf, expoConf] = await pythConsumer.getPriceWithConfidence(XMR_USD_PRICE_ID);
    const humanConf = Number(conf) * Math.pow(10, Number(expoConf));
    console.log("\n📈 Confidence: ±$" + humanConf.toFixed(2) + " (" + ((humanConf / humanPrice) * 100).toFixed(2) + "%)");
    
    console.log("\n✅ LIVE Pyth Oracle working on Gnosis Chain!");
    console.log("Contract: https://gnosisscan.io/address/" + CONTRACT_ADDRESS);
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
