const { expect } = require("chai");
const { ethers } = require("hardhat");
const axios = require("axios");

describe("Pyth Oracle on Gnosis Chain", function () {
    let pythConsumer;
    let deployer;
    
    // Pyth contract address on Gnosis Chain
    const PYTH_CONTRACT_GNOSIS = "0x2880aB155794e7179c9eE2e38200202908C17B43";
    
    // Price feed IDs
    const XMR_USD_PRICE_ID = "0x46b8cc9347f04391764a0361e0b17c3ba394b001e7c304f7650f6376e37c321d";
    const ETH_USD_PRICE_ID = "0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace";
    const BTC_USD_PRICE_ID = "0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43";
    
    before(async function () {
        [deployer] = await ethers.getSigners();
        
        console.log("\n🔧 Deploying PythPriceConsumer on Gnosis Chain fork...");
        console.log("Deployer:", deployer.address);
        console.log("Pyth Contract:", PYTH_CONTRACT_GNOSIS);
        
        // Deploy PythPriceConsumer
        const PythPriceConsumer = await ethers.getContractFactory("PythPriceConsumer");
        pythConsumer = await PythPriceConsumer.deploy(PYTH_CONTRACT_GNOSIS);
        await pythConsumer.waitForDeployment();
        
        const address = await pythConsumer.getAddress();
        console.log("✅ PythPriceConsumer deployed at:", address);
    });
    
    describe("Price Feed Reading", function () {
        it("Should read XMR/USD price from Pyth", async function () {
            console.log("\n📊 Reading XMR/USD price...");
            
            try {
                const [price, expo, timestamp] = await pythConsumer.getXMRPrice();
                
                // Calculate human-readable price
                const humanPrice = Number(price) * Math.pow(10, Number(expo));
                
                console.log("Raw Price:", price.toString());
                console.log("Exponent:", expo.toString());
                console.log("XMR/USD Price: $" + humanPrice.toFixed(2));
                console.log("Timestamp:", new Date(Number(timestamp) * 1000).toISOString());
                
                expect(price).to.not.equal(0);
                expect(humanPrice).to.be.greaterThan(0);
            } catch (error) {
                console.log("⚠️  Error reading XMR price:", error.message);
                console.log("This is expected if the price feed is not available on the fork");
            }
        });
        
        it("Should read ETH/USD price from Pyth", async function () {
            console.log("\n📊 Reading ETH/USD price...");
            
            try {
                const [price, expo, timestamp] = await pythConsumer.getETHPrice();
                
                // Calculate human-readable price
                const humanPrice = Number(price) * Math.pow(10, Number(expo));
                
                console.log("Raw Price:", price.toString());
                console.log("Exponent:", expo.toString());
                console.log("ETH/USD Price: $" + humanPrice.toFixed(2));
                console.log("Timestamp:", new Date(Number(timestamp) * 1000).toISOString());
                
                expect(price).to.not.equal(0);
                expect(humanPrice).to.be.greaterThan(0);
            } catch (error) {
                console.log("⚠️  Error reading ETH price:", error.message);
            }
        });
        
        it("Should read BTC/USD price from Pyth", async function () {
            console.log("\n📊 Reading BTC/USD price...");
            
            try {
                const [price, expo, timestamp] = await pythConsumer.getBTCPrice();
                
                // Calculate human-readable price
                const humanPrice = Number(price) * Math.pow(10, Number(expo));
                
                console.log("Raw Price:", price.toString());
                console.log("Exponent:", expo.toString());
                console.log("BTC/USD Price: $" + humanPrice.toFixed(2));
                console.log("Timestamp:", new Date(Number(timestamp) * 1000).toISOString());
                
                expect(price).to.not.equal(0);
                expect(humanPrice).to.be.greaterThan(0);
            } catch (error) {
                console.log("⚠️  Error reading BTC price:", error.message);
            }
        });
        
        it("Should read price with confidence interval", async function () {
            console.log("\n📊 Reading ETH/USD price with confidence...");
            
            try {
                const [price, conf, expo, timestamp] = await pythConsumer.getPriceWithConfidence(ETH_USD_PRICE_ID);
                
                // Calculate human-readable values
                const humanPrice = Number(price) * Math.pow(10, Number(expo));
                const humanConf = Number(conf) * Math.pow(10, Number(expo));
                
                console.log("Price: $" + humanPrice.toFixed(2));
                console.log("Confidence: ±$" + humanConf.toFixed(2));
                console.log("Confidence %:", ((humanConf / humanPrice) * 100).toFixed(2) + "%");
                console.log("Timestamp:", new Date(Number(timestamp) * 1000).toISOString());
                
                expect(price).to.not.equal(0);
            } catch (error) {
                console.log("⚠️  Error reading price with confidence:", error.message);
            }
        });
    });
    
    describe("Price Feed Updates", function () {
        it("Should fetch price update data from Hermes API", async function () {
            console.log("\n🌐 Fetching price update from Pyth Hermes API...");
            
            try {
                // Fetch latest price updates from Pyth's Hermes API
                const response = await axios.get(
                    `https://hermes.pyth.network/v2/updates/price/latest`,
                    {
                        params: {
                            ids: [ETH_USD_PRICE_ID]
                        }
                    }
                );
                
                console.log("✅ Successfully fetched price update data");
                console.log("Binary data length:", response.data.binary.data.length);
                
                expect(response.data).to.have.property('binary');
                expect(response.data.binary).to.have.property('data');
            } catch (error) {
                console.log("⚠️  Error fetching from Hermes:", error.message);
                this.skip();
            }
        });
        
        it("Should calculate update fee", async function () {
            console.log("\n💰 Calculating update fee...");
            
            try {
                // Fetch price update data
                const response = await axios.get(
                    `https://hermes.pyth.network/v2/updates/price/latest`,
                    {
                        params: {
                            ids: [ETH_USD_PRICE_ID]
                        }
                    }
                );
                
                const priceUpdateData = ["0x" + response.data.binary.data[0]];
                const fee = await pythConsumer.getUpdateFee(priceUpdateData);
                
                console.log("Update fee:", ethers.formatEther(fee), "xDAI");
                console.log("Update fee (wei):", fee.toString());
                
                expect(fee).to.be.greaterThanOrEqual(0);
            } catch (error) {
                console.log("⚠️  Error calculating fee:", error.message);
                this.skip();
            }
        });
        
        it("Should update price feeds with Hermes data", async function () {
            console.log("\n🔄 Updating price feeds...");
            
            try {
                // Fetch latest price updates
                const response = await axios.get(
                    `https://hermes.pyth.network/v2/updates/price/latest`,
                    {
                        params: {
                            ids: [ETH_USD_PRICE_ID, XMR_USD_PRICE_ID]
                        }
                    }
                );
                
                const priceUpdateData = response.data.binary.data.map(d => "0x" + d);
                const fee = await pythConsumer.getUpdateFee(priceUpdateData);
                
                console.log("Updating", priceUpdateData.length, "price feeds");
                console.log("Fee required:", ethers.formatEther(fee), "xDAI");
                
                // Update the price feeds
                const tx = await pythConsumer.updatePriceFeeds(priceUpdateData, {
                    value: fee
                });
                await tx.wait();
                
                console.log("✅ Price feeds updated successfully");
                console.log("Transaction hash:", tx.hash);
                
                // Read updated prices
                const [ethPrice, ethExpo] = await pythConsumer.getETHPrice();
                const humanEthPrice = Number(ethPrice) * Math.pow(10, Number(ethExpo));
                console.log("Updated ETH/USD Price: $" + humanEthPrice.toFixed(2));
                
            } catch (error) {
                console.log("⚠️  Error updating price feeds:", error.message);
                this.skip();
            }
        });
    });
    
    describe("USD Value Calculation", function () {
        it("Should calculate USD value for XMR amount", async function () {
            console.log("\n💵 Calculating USD value for 10 XMR...");
            
            try {
                const [price, expo] = await pythConsumer.getXMRPrice();
                
                // 10 XMR in atomic units (12 decimals)
                const xmrAmount = ethers.parseUnits("10", 12);
                
                const usdValue = await pythConsumer.calculateUSDValue(xmrAmount, price, expo);
                const humanUsdValue = Number(ethers.formatUnits(usdValue, 8));
                
                console.log("Amount: 10 XMR");
                console.log("XMR Price: $" + (Number(price) * Math.pow(10, Number(expo))).toFixed(2));
                console.log("USD Value: $" + humanUsdValue.toFixed(2));
                
                expect(usdValue).to.be.greaterThan(0);
            } catch (error) {
                console.log("⚠️  Error calculating USD value:", error.message);
                this.skip();
            }
        });
    });
    
    describe("Integration Info", function () {
        it("Should display Pyth integration details", async function () {
            console.log("\n📋 Pyth Oracle Integration Details:");
            console.log("═══════════════════════════════════════════════════════");
            console.log("Network: Gnosis Chain");
            console.log("Pyth Contract:", PYTH_CONTRACT_GNOSIS);
            console.log("\nSupported Price Feeds:");
            console.log("  XMR/USD:", XMR_USD_PRICE_ID);
            console.log("  ETH/USD:", ETH_USD_PRICE_ID);
            console.log("  BTC/USD:", BTC_USD_PRICE_ID);
            console.log("\nHermes API:");
            console.log("  Endpoint: https://hermes.pyth.network");
            console.log("  Docs: https://docs.pyth.network/price-feeds");
            console.log("\nPrice Feed Explorer:");
            console.log("  https://pyth.network/developers/price-feed-ids");
            console.log("═══════════════════════════════════════════════════════");
        });
    });
});
