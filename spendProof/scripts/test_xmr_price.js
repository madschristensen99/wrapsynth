const { ethers } = require("hardhat");
const axios = require("axios");

async function main() {
    console.log("\n🔧 Testing XMR/USD Price from Pyth Oracle on Gnosis Chain\n");
    
    const [deployer] = await ethers.getSigners();
    console.log("Deployer:", deployer.address);
    
    // Pyth contract address on Gnosis Chain
    const PYTH_CONTRACT_GNOSIS = "0x2880aB155794e7179c9eE2e38200202908C17B43";
    
    // XMR/USD price feed ID
    const XMR_USD_PRICE_ID = "0x46b8cc9347f04391764a0361e0b17c3ba394b001e7c304f7650f6376e37c321d";
    
    // Deploy PythPriceConsumer
    console.log("📦 Deploying PythPriceConsumer...");
    const PythPriceConsumer = await ethers.getContractFactory("PythPriceConsumer");
    const pythConsumer = await PythPriceConsumer.deploy(PYTH_CONTRACT_GNOSIS);
    await pythConsumer.waitForDeployment();
    
    const address = await pythConsumer.getAddress();
    console.log("✅ PythPriceConsumer deployed at:", address);
    
    // First, update XMR price from Hermes API
    console.log("\n🌐 Fetching latest XMR/USD price from Pyth Hermes API...");
    try {
        const response = await axios.get(
            `https://hermes.pyth.network/v2/updates/price/latest`,
            {
                params: {
                    ids: [XMR_USD_PRICE_ID]
                }
            }
        );
        
        console.log("✅ Successfully fetched XMR price update from Hermes");
        
        // Parse the price from the response
        if (response.data.parsed && response.data.parsed.length > 0) {
            const priceData = response.data.parsed[0].price;
            const price = Number(priceData.price) * Math.pow(10, priceData.expo);
            console.log("📊 Current XMR/USD Price from Hermes: $" + price.toFixed(2));
            console.log("   Confidence: ±$" + (Number(priceData.conf) * Math.pow(10, priceData.expo)).toFixed(2));
            console.log("   Timestamp:", new Date(priceData.publish_time * 1000).toISOString());
        }
        
        // Update the on-chain price feed
        const priceUpdateData = response.data.binary.data.map(d => "0x" + d);
        const fee = await pythConsumer.getUpdateFee(priceUpdateData);
        
        console.log("\n🔄 Updating XMR price feed on-chain...");
        console.log("   Update fee:", ethers.formatEther(fee), "xDAI");
        
        const tx = await pythConsumer.updatePriceFeeds(priceUpdateData, {
            value: fee
        });
        await tx.wait();
        
        console.log("✅ XMR price feed updated successfully!");
        console.log("   Transaction hash:", tx.hash);
        
        // Now read the updated price from the contract
        console.log("\n📊 Reading XMR/USD price from on-chain Pyth contract...");
        const [price, expo, timestamp] = await pythConsumer.getXMRPrice();
        const humanPrice = Number(price) * Math.pow(10, Number(expo));
        
        console.log("\n╔════════════════════════════════════════╗");
        console.log("║     XMR/USD PRICE (from Pyth)          ║");
        console.log("╠════════════════════════════════════════╣");
        console.log("║  Price: $" + humanPrice.toFixed(2).padEnd(30) + "║");
        console.log("║  Raw:   " + price.toString().padEnd(32) + "║");
        console.log("║  Expo:  " + expo.toString().padEnd(32) + "║");
        console.log("║  Time:  " + new Date(Number(timestamp) * 1000).toISOString().padEnd(26) + "║");
        console.log("╚════════════════════════════════════════╝");
        
        // Test with confidence interval
        const [priceConf, conf, expoConf, timestampConf] = await pythConsumer.getPriceWithConfidence(XMR_USD_PRICE_ID);
        const humanPriceConf = Number(priceConf) * Math.pow(10, Number(expoConf));
        const humanConf = Number(conf) * Math.pow(10, Number(expoConf));
        
        console.log("\n📈 Price with Confidence Interval:");
        console.log("   Price: $" + humanPriceConf.toFixed(2));
        console.log("   Confidence: ±$" + humanConf.toFixed(2) + " (" + ((humanConf / humanPriceConf) * 100).toFixed(2) + "%)");
        
        // Calculate USD value for sample XMR amounts
        console.log("\n💰 Sample XMR to USD Conversions:");
        const amounts = [1, 10, 100];
        for (const amount of amounts) {
            const xmrAmount = ethers.parseUnits(amount.toString(), 12); // XMR has 12 decimals
            const usdValue = await pythConsumer.calculateUSDValue(xmrAmount, price, expo);
            const humanUsdValue = Number(ethers.formatUnits(usdValue, 8));
            console.log(`   ${amount} XMR = $${humanUsdValue.toFixed(2)}`);
        }
        
    } catch (error) {
        console.error("❌ Error:", error.message);
        if (error.response) {
            console.error("   Response:", error.response.data);
        }
        process.exit(1);
    }
    
    console.log("\n✅ XMR price oracle test complete!\n");
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
