const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
  console.log("════════════════════════════════════════════════════════════════");
  console.log("  WrapSynth Deployment - Gnosis Mainnet");
  console.log("════════════════════════════════════════════════════════════════\n");

  const [deployer] = await hre.ethers.getSigners();
  console.log("Deploying contracts with account:", deployer.address);
  
  const balance = await hre.ethers.provider.getBalance(deployer.address);
  console.log("Account balance:", hre.ethers.formatEther(balance), "xDAI\n");

  // Gnosis Mainnet addresses
  // sDAI (Savings DAI) on Gnosis: https://gnosisscan.io/token/0xaf204776c7245bF4147c2612BF6e5972Ee483701
  const SDAI_ADDRESS = process.env.SDAI_ADDRESS || "0xaf204776c7245bF4147c2612BF6e5972Ee483701";
  
  // Pyth Oracle on Gnosis: https://docs.pyth.network/price-feeds/contract-addresses/evm
  const PYTH_ADDRESS = process.env.PYTH_ADDRESS || "0x2880aB155794e7179c9eE2e38200202908C17B43";
  
  const ORACLE_ADDRESS = process.env.ORACLE_ADDRESS || deployer.address;

  console.log("Configuration:");
  console.log("  sDAI:", SDAI_ADDRESS);
  console.log("  Pyth Oracle:", PYTH_ADDRESS);
  console.log("  Oracle Address:", ORACLE_ADDRESS);
  console.log("");

  // ══════════════════════════════════════════════════════════════════════════
  // Step 1: Deploy PLONK Verifier
  // ══════════════════════════════════════════════════════════════════════════
  
  console.log("[1/2] Deploying PLONK Verifier...");
  const PlonkVerifier = await hre.ethers.getContractFactory("PlonkVerifier");
  
  console.log("Estimating gas for PlonkVerifier deployment...");
  const verifier = await PlonkVerifier.deploy();
  await verifier.waitForDeployment();
  const verifierAddress = await verifier.getAddress();
  console.log("✓ PLONK Verifier deployed to:", verifierAddress);
  console.log("");

  // ══════════════════════════════════════════════════════════════════════════
  // Step 2: Deploy WrappedMonero
  // ══════════════════════════════════════════════════════════════════════════
  
  console.log("[2/2] Deploying WrappedMonero...");
  
  // Get current Monero block height
  let initialMoneroBlock = 3605079; // Fallback value
  
  const moneroRpcUrl = process.env.MONERO_RPC_URL || "http://xmr.privex.io:18081";
  console.log("Fetching current Monero block height from:", moneroRpcUrl);
  
  try {
    const axios = require("axios");
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
    console.warn("⚠ Using fallback height:", initialMoneroBlock);
  }

  console.log("\nConfiguration:");
  console.log("  Initial Monero Block:", initialMoneroBlock);
  console.log("");

  const WrappedMonero = await hre.ethers.getContractFactory("WrappedMonero");
  const wrappedMonero = await WrappedMonero.deploy(
    verifierAddress,
    SDAI_ADDRESS,
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
      sDAI: SDAI_ADDRESS,
      pyth: PYTH_ADDRESS,
      oracle: ORACLE_ADDRESS,
    },
    initialMoneroBlock: initialMoneroBlock,
  };

  const deploymentsDir = path.join(__dirname, "..", "..", "deployments");
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
  console.log("  1. Verify contracts: npm run verify:gnosis");
  console.log("  2. Update Pyth prices: wrappedMonero.updatePythPrice(priceUpdateData)");
  console.log("  3. Register as LP: wrappedMonero.registerLP(mintFeeBps, burnFeeBps)");
  console.log("  4. Deposit collateral: wrappedMonero.lpDeposit{value: xDAI_amount}()");
  console.log("");

  console.log("Block Explorer:");
  console.log("  https://gnosisscan.io/address/" + wrappedMoneroAddress);
  console.log("");

  console.log("⚠️  IMPORTANT: This is a mainnet deployment!");
  console.log("⚠️  Please ensure thorough testing before allowing real users.");
  console.log("");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
