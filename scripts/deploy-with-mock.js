const hre = require("hardhat");
const fs = require("fs");
const path = require("path");
const axios = require("axios");

async function main() {
  console.log("════════════════════════════════════════════════════════════════");
  console.log("  Hooked Monero Deployment with Mock wstETH - Unichain Testnet");
  console.log("════════════════════════════════════════════════════════════════\n");

  const [deployer] = await hre.ethers.getSigners();
  console.log("Deploying contracts with account:", deployer.address);
  
  const balance = await hre.ethers.provider.getBalance(deployer.address);
  console.log("Account balance:", hre.ethers.formatEther(balance), "ETH\n");

  const PYTH_ADDRESS = process.env.PYTH_ADDRESS || "0x2880aB155794e7179c9eE2e38200202908C17B43";

  // ══════════════════════════════════════════════════════════════════════════
  // Step 1: Deploy Mock wstETH
  // ══════════════════════════════════════════════════════════════════════════
  
  console.log("[1/4] Deploying Mock wstETH...");
  const MockWstETH = await hre.ethers.getContractFactory("MockWstETH");
  const mockWstETH = await MockWstETH.deploy();
  await mockWstETH.waitForDeployment();
  const wstETHAddress = await mockWstETH.getAddress();
  
  console.log("✓ Mock wstETH deployed to:", wstETHAddress);
  console.log("");

  // ══════════════════════════════════════════════════════════════════════════
  // Step 2: Deploy PLONK Verifier
  // ══════════════════════════════════════════════════════════════════════════
  
  console.log("[2/4] Deploying PLONK Verifier...");
  const PlonkVerifier = await hre.ethers.getContractFactory("PlonkVerifier");
  const verifier = await PlonkVerifier.deploy();
  await verifier.waitForDeployment();
  const verifierAddress = await verifier.getAddress();
  
  console.log("✓ PLONK Verifier deployed to:", verifierAddress);
  console.log("");

  // ══════════════════════════════════════════════════════════════════════════
  // Step 3: Update Pyth Prices
  // ══════════════════════════════════════════════════════════════════════════
  
  console.log("[3/4] Updating Pyth prices on-chain...");
  
  const XMR_USD_PRICE_ID = "0x46b8cc9347f04391764a0361e0b17c3ba394b001e7c304f7650f6376e37c321d";
  const ETH_USD_PRICE_ID = "0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace";
  
  console.log("Fetching latest prices from Pyth Hermes...");
  const hermesUrl = `https://hermes.pyth.network/v2/updates/price/latest?ids[]=${XMR_USD_PRICE_ID}&ids[]=${ETH_USD_PRICE_ID}`;
  const response = await axios.get(hermesUrl);
  
  if (!response.data || !response.data.binary || !response.data.binary.data) {
    throw new Error("Failed to fetch price data from Hermes");
  }
  
  const priceUpdateData = response.data.binary.data.map(data => '0x' + data);
  console.log("✓ Fetched price update data");
  
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
  // Step 4: Deploy WrappedMonero
  // ══════════════════════════════════════════════════════════════════════════
  
  console.log("[4/4] Deploying WrappedMonero...");
  const WrappedMonero = await hre.ethers.getContractFactory("WrappedMonero");
  
  // Fetch current Monero mainnet block height
  console.log("Fetching current Monero block height...");
  const moneroRpcUrl = process.env.MONERO_RPC_URL || "http://xmr.privex.io:18081";
  const moneroResponse = await axios.post(moneroRpcUrl + "/json_rpc", {
    jsonrpc: "2.0",
    id: "0",
    method: "get_block_count"
  });
  
  const initialMoneroBlock = moneroResponse.data.result.count - 1; // Use latest confirmed block
  console.log("Current Monero block:", initialMoneroBlock);

  console.log("Configuration:");
  console.log("  Initial Monero Block:", initialMoneroBlock);
  console.log("  wstETH (Mock):", wstETHAddress);
  console.log("  Pyth Oracle:", PYTH_ADDRESS);
  console.log("");

  const wrappedMonero = await WrappedMonero.deploy(
    verifierAddress,
    wstETHAddress,
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
    network: "unichain_testnet",
    chainId: 1301,
    timestamp: new Date().toISOString(),
    deployer: deployer.address,
    contracts: {
      MockWstETH: wstETHAddress,
      PlonkVerifier: verifierAddress,
      WrappedMonero: wrappedMoneroAddress,
    },
    dependencies: {
      pyth: PYTH_ADDRESS,
    },
  };

  const deploymentsDir = path.join(__dirname, "..", "deployments");
  if (!fs.existsSync(deploymentsDir)) {
    fs.mkdirSync(deploymentsDir, { recursive: true });
  }

  const filename = `unichain_testnet_mock_${Date.now()}.json`;
  const filepath = path.join(deploymentsDir, filename);
  const latestPath = path.join(deploymentsDir, "unichain_testnet_mock_latest.json");

  fs.writeFileSync(filepath, JSON.stringify(deploymentInfo, null, 2));
  fs.writeFileSync(latestPath, JSON.stringify(deploymentInfo, null, 2));

  console.log("════════════════════════════════════════════════════════════════");
  console.log("✓ Deployment Complete!");
  console.log("════════════════════════════════════════════════════════════════\n");

  console.log("Deployed Contracts:");
  console.log("  MockWstETH:", wstETHAddress);
  console.log("  PlonkVerifier:", verifierAddress);
  console.log("  WrappedMonero:", wrappedMoneroAddress);
  console.log("");

  console.log("Deployment info saved to:");
  console.log("  " + filepath);
  console.log("");

  console.log("Next Steps:");
  console.log("  1. Verify contracts: npm run verify:mock");
  console.log("  2. Setup LP: npm run lp:setup:mock");
  console.log("  3. Start oracle: ./scripts/oracle/run.sh");
  console.log("");

  console.log("Block Explorer:");
  console.log("  https://sepolia.uniscan.xyz/address/" + wrappedMoneroAddress);
  console.log("");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
