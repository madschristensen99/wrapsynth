const { ethers } = require("hardhat");
const axios = require("axios");

async function main() {
    console.log("\n🔧 Testing Pyth Oracle Integration on Gnosis Chain\n");
    
    const [deployer] = await ethers.getSigners();
    console.log("Deployer:", deployer.address);
    
    // Pyth contract address on Gnosis Chain
    const PYTH_CONTRACT_GNOSIS = "0x2880aB155794e7179c9eE2e38200202908C17B43";
    
    // Price feed IDs
    const XMR_USD_PRICE_ID = "0x46b8cc9347f04391764a0361e0b17c3ba394b001e7c304f7650f6376e37c321d";
    const ETH_USD_PRICE_ID = "0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace";
    
    // Deploy PythPriceConsumer
    console.log("\n📦 Deploying PythPriceConsumer...");
    const PythPriceConsumer = await ethers.getContractFactory("PythPriceConsumer");
    const pythConsumer = await PythPriceConsumer.deploy(PYTH_CONTRACT_GNOSIS);
    await pythConsumer.waitForDeployment();
    
    const address = await pythConsumer.getAddress();
    console.log("✅ PythPriceConsumer deployed at:", address);
    
    // Read XMR price
    console.log("\n📊 Reading XMR/USD price...");
    try {
        const [price, expo, timestamp] = await pythConsumer.getXMRPrice();
        const humanPrice = Number(price) * Math.pow(10, Number(expo));
        
        console.log("Raw Price:", price.toString());
        console.log("Exponent:", expo.toString());
        console.log("XMR/USD Price: $" + humanPrice.toFixed(2));
        console.log("Timestamp:", new Date(Number(timestamp) * 1000).toISOString());
    } catch (error) {
        console.log("⚠️  Error:", error.message);
    }
    
    // Read ETH price
    console.log("\n📊 Reading ETH/USD price...");
    try {
        const [price, expo, timestamp] = await pythConsumer.getETHPrice();
        const humanPrice = Number(price) * Math.pow(10, Number(expo));
        
        console.log("Raw Price:", price.toString());
        console.log("Exponent:", expo.toString());
        console.log("ETH/USD Price: $" + humanPrice.toFixed(2));
        console.log("Timestamp:", new Date(Number(timestamp) * 1000).toISOString());
    } catch (error) {
        console.log("⚠️  Error:", error.message);
    }
    
    // Fetch and update prices from Hermes
    console.log("\n🌐 Fetching latest prices from Pyth Hermes API...");
    try {
        const response = await axios.get(
            `https://hermes.pyth.network/v2/updates/price/latest`,
            {
                params: {
                    ids: [ETH_USD_PRICE_ID, XMR_USD_PRICE_ID]
                }
            }
        );
        
        console.log("✅ Fetched price updates for", response.data.binary.data.length, "feeds");
        
        const priceUpdateData = response.data.binary.data.map(d => "0x" + d);
        const fee = await pythConsumer.getUpdateFee(priceUpdateData);
        
        console.log("Update fee:", ethers.formatEther(fee), "xDAI");
        
        // Update the price feeds
        console.log("\n🔄 Updating price feeds on-chain...");
        const tx = await pythConsumer.updatePriceFeeds(priceUpdateData, {
            value: fee
        });
        await tx.wait();
        
        console.log("✅ Price feeds updated successfully!");
        console.log("Transaction hash:", tx.hash);
        
        // Read updated prices
        const [ethPrice, ethExpo] = await pythConsumer.getETHPrice();
        const humanEthPrice = Number(ethPrice) * Math.pow(10, Number(ethExpo));
        console.log("Updated ETH/USD Price: $" + humanEthPrice.toFixed(2));
        
    } catch (error) {
        console.log("⚠️  Error:", error.message);
    }
    
    console.log("\n✅ Pyth Oracle integration test complete!\n");
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
