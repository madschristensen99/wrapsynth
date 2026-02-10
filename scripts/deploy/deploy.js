const hre = require("hardhat");
const fs = require("fs");
const path = require("path");
const axios = require("axios");

async function main() {
  console.log("════════════════════════════════════════════════════════════════");
  console.log("  Hooked Monero Deployment - Unichain Testnet");
  console.log("════════════════════════════════════════════════════════════════\n");

  const [deployer] = await hre.ethers.getSigners();
  console.log("Deploying contracts with account:", deployer.address);
  
  const balance = await hre.ethers.provider.getBalance(deployer.address);
  console.log("Account balance:", hre.ethers.formatEther(balance), "ETH\n");

  // Unichain Testnet addresses
  const WSTETH_ADDRESS = process.env.WSTETH_ADDRESS || "0xc02fe7317d4eb8753a02c35fe019786854a92001";
  const PYTH_ADDRESS = process.env.PYTH_ADDRESS || "0x2880aB155794e7179c9eE2e38200202908C17B43";
  const ORACLE_ADDRESS = process.env.ORACLE_ADDRESS || deployer.address;

  console.log("Configuration:");
  console.log("  wstETH:", WSTETH_ADDRESS);
  console.log("  Pyth Oracle:", PYTH_ADDRESS);
  console.log("  Oracle Address:", ORACLE_ADDRESS);
  console.log("");

  // ══════════════════════════════════════════════════════════════════════════
  // Step 1: Deploy PLONK Verifier
  // ══════════════════════════════════════════════════════════════════════════
  
  console.log("[1/2] Deploying PLONK Verifier...");
  const PlonkVerifier = await hre.ethers.getContractFactory("PlonkVerifier");
  const verifier = await PlonkVerifier.deploy();
  await verifier.waitForDeployment();
  const verifierAddress = await verifier.getAddress();
  console.log("✓ PLONK Verifier deployed to:", verifierAddress);
  console.log("");

  // ══════════════════════════════════════════════════════════════════════════
  // Step 2: Update Pyth Prices
  // ══════════════════════════════════════════════════════════════════════════
  
  console.log("[2/3] Updating Pyth prices on-chain...");
  
  const XMR_USD_PRICE_ID = "0x46b8cc9347f04391764a0361e0b17c3ba394b001e7c304f7650f6376e37c321d";
  const ETH_USD_PRICE_ID = "0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace";
  
  // Fetch price update data from Hermes
  console.log("Fetching latest prices from Pyth Hermes...");
  const hermesUrl = `https://hermes.pyth.network/v2/updates/price/latest?ids[]=${XMR_USD_PRICE_ID}&ids[]=${ETH_USD_PRICE_ID}`;
  const response = await axios.get(hermesUrl);
  
  if (!response.data || !response.data.binary || !response.data.binary.data) {
    throw new Error("Failed to fetch price data from Hermes");
  }
  
  const priceUpdateData = response.data.binary.data.map(data => '0x' + data);
  console.log("✓ Fetched price update data");
  
  // Update prices on Pyth contract
  const pythAbi = [
    "function updatePriceFeeds(bytes[] calldata updateData) external payable",
    "function getUpdateFee(bytes[] calldata updateData) external view returns (uint256)",
  ];
  
  const pyth = await hre.ethers.getContractAt(pythAbi, PYTH_ADDRESS);
  const updateFee = await pyth.getUpdateFee(priceUpdateData);
  
  console.log("Updating prices (fee:", hre.ethers.formatEther(updateFee), "ETH)...");
  const updateTx = await pyth.updatePriceFeeds(priceUpdateData, { value: updateFee });
  await updateTx.wait();
  console.log("✓ Prices updated on-chain");
  console.log("");

  // ══════════════════════════════════════════════════════════════════════════
  // Step 3: Deploy WrappedMonero
  // ══════════════════════════════════════════════════════════════════════════
  
  console.log("[3/3] Deploying WrappedMonero...");
  const WrappedMonero = await hre.ethers.getContractFactory("WrappedMonero");
  
  // Fetch current Monero blockchain height
  console.log("Fetching current Monero blockchain height...");
  const moneroRpcUrl = process.env.MONERO_RPC_URL || "http://xmr.privex.io:18081";
  let initialMoneroBlock;
  
  try {
    const moneroResponse = await axios.post(moneroRpcUrl + "/json_rpc", {
      jsonrpc: "2.0",
      id: "0",
      method: "get_block_count"
    });
    
    if (moneroResponse.data && moneroResponse.data.result && moneroResponse.data.result.count) {
      // Use current height minus 1 (since count is height + 1)
      initialMoneroBlock = moneroResponse.data.result.count - 1;
      console.log("✓ Current Monero height:", initialMoneroBlock);
    } else {
      throw new Error("Invalid response from Monero RPC");
    }
  } catch (error) {
    console.warn("⚠ Failed to fetch Monero height:", error.message);
    console.warn("⚠ Using fallback height: 3605079");
    initialMoneroBlock = 3605079;
  }

  console.log("\nConfiguration:");
  console.log("  Initial Monero Block:", initialMoneroBlock);
  console.log("  Prices: Updated on Pyth contract");
  console.log("");

  const wrappedMonero = await WrappedMonero.deploy(
    verifierAddress,
    WSTETH_ADDRESS,
    PYTH_ADDRESS,
    initialMoneroBlock
  );
  
  await wrappedMonero.waitForDeployment();
  const wrappedMoneroAddress = await wrappedMonero.getAddress();
  console.log("✓ WrappedMonero deployed to:", wrappedMoneroAddress);
  console.log("");

  // ══════════════════════════════════════════════════════════════════════════
  // Save Deployment Info
  // ══════════════════════════════════════════════════════════════════════════
  
  const deploymentInfo = {
    network: hre.network.name,
    chainId: (await hre.ethers.provider.getNetwork()).chainId.toString(),
    deployer: deployer.address,
    timestamp: new Date().toISOString(),
    contracts: {
      PlonkVerifier: verifierAddress,
      WrappedMonero: wrappedMoneroAddress,
    },
    dependencies: {
      wstETH: WSTETH_ADDRESS,
      pyth: PYTH_ADDRESS,
      oracle: ORACLE_ADDRESS,
    },
    initialMoneroBlock: initialMoneroBlock,
  };

  const deploymentsDir = path.join(__dirname, "..", "deployments");
  if (!fs.existsSync(deploymentsDir)) {
    fs.mkdirSync(deploymentsDir, { recursive: true });
  }

  const filename = `${hre.network.name}_${Date.now()}.json`;
  const filepath = path.join(deploymentsDir, filename);
  fs.writeFileSync(filepath, JSON.stringify(deploymentInfo, null, 2));

  // Also save as latest
  const latestPath = path.join(deploymentsDir, `${hre.network.name}_latest.json`);
  fs.writeFileSync(latestPath, JSON.stringify(deploymentInfo, null, 2));

  console.log("════════════════════════════════════════════════════════════════");
  console.log("✓ Deployment Complete!");
  console.log("════════════════════════════════════════════════════════════════\n");

  console.log("Deployed Contracts:");
  console.log("  PlonkVerifier:", verifierAddress);
  console.log("  WrappedMonero:", wrappedMoneroAddress);
  console.log("");

  console.log("Deployment info saved to:");
  console.log(" ", filepath);
  console.log("");

  console.log("Next Steps:");
  console.log("  1. Verify contracts on block explorer");
  console.log("  2. Register as LP: wrappedMonero.registerLP(mintFeeBps, burnFeeBps)");
  console.log("  3. Deposit collateral: wrappedMonero.lpDeposit{value: ethAmount}()");
  console.log("  4. Update Pyth prices: wrappedMonero.updatePythPrice(priceUpdateData)");
  console.log("");

  console.log("Block Explorer:");
  console.log("  https://unichain-sepolia.blockscout.com/address/" + wrappedMoneroAddress);
  console.log("");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
