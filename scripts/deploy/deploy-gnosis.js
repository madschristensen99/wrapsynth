const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
  console.log("Starting Gnosis Chain deployment...\n");

  const [deployer] = await hre.ethers.getSigners();
  console.log("Deploying contracts with account:", deployer.address);
  
  const balance = await hre.ethers.provider.getBalance(deployer.address);
  console.log("Account balance:", hre.ethers.formatEther(balance), "xDAI\n");

  const PYTH_ORACLE = "0x2880aB155794e7179c9eE2e38200202908C17B43";
  const SDAI = "0xaf204776c7245bF4147c2612BF6e5972Ee483701";
  const XDAI = "0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d";
  const UNISWAP_V3_ROUTER = "0xE592427A0AEce92De3Edee1F18E0157C05861564";
  
  const DAI_USD_FEED_ID = "0xb0948a5e5313200c632b51bb5ca32f6de0d36e9950a942d19751e833f70dabfd";

  console.log("=".repeat(60));
  console.log("STEP 1: Deploying VaultManager (deploys wsXMR automatically)");
  console.log("=".repeat(60));
  
  const VaultManager = await hre.ethers.getContractFactory("VaultManager");
  console.log("Deploying with parameters:");
  console.log("  - Pyth Oracle:", PYTH_ORACLE);
  
  const vaultManager = await VaultManager.deploy(PYTH_ORACLE);
  await vaultManager.waitForDeployment();
  const vaultManagerAddress = await vaultManager.getAddress();
  
  console.log("✓ VaultManager deployed to:", vaultManagerAddress);
  console.log();

  console.log("=".repeat(60));
  console.log("STEP 2: Reading wsXMR Token Address");
  console.log("=".repeat(60));
  
  const wsxmrAddress = await vaultManager.wsxmrToken();
  console.log("✓ wsXMR automatically deployed to:", wsxmrAddress);
  console.log("✓ wsXMR immutably linked to VaultManager");
  console.log("✓ sDAI is the only supported collateral (hardcoded)");
  console.log();

  console.log("=".repeat(60));
  console.log("STEP 3: Deploying wsXMRLiquidityRouter");
  console.log("=".repeat(60));
  
  const UNISWAP_V3_POSITION_MANAGER = "0xC36442b4a4522E871399CD717aBDD847Ab11FE88";
  const UNISWAP_V3_FACTORY = "0xf78031CBCA409F2FB6876BDFDBc1b2df24cF9bEf";
  
  const Router = await hre.ethers.getContractFactory("wsXMRLiquidityRouter");
  const router = await Router.deploy(
    vaultManagerAddress,
    wsxmrAddress,
    UNISWAP_V3_POSITION_MANAGER,
    UNISWAP_V3_FACTORY
  );
  await router.waitForDeployment();
  const routerAddress = await router.getAddress();
  
  console.log("✓ wsXMRLiquidityRouter deployed to:", routerAddress);
  console.log();

  console.log("=".repeat(60));
  console.log("DEPLOYMENT SUMMARY");
  console.log("=".repeat(60));
  console.log("Network: Gnosis Chain (ChainID: 100)");
  console.log("Deployer:", deployer.address);
  console.log();
  console.log("Deployed Contracts:");
  console.log("  wsXMR:                ", wsxmrAddress);
  console.log("  VaultManager:         ", vaultManagerAddress);
  console.log("  wsXMRLiquidityRouter: ", routerAddress);
  console.log();
  console.log("External Contracts:");
  console.log("  Pyth Oracle:          ", PYTH_ORACLE);
  console.log("  sDAI:                 ", SDAI);
  console.log("  xDAI:                 ", XDAI);
  console.log("  Uniswap V3 Router:    ", UNISWAP_V3_ROUTER);
  console.log("=".repeat(60));

  const deploymentData = {
    network: "gnosis",
    chainId: 100,
    deployer: deployer.address,
    timestamp: new Date().toISOString(),
    contracts: {
      wsXMR: wsxmrAddress,
      VaultManager: vaultManagerAddress,
      wsXMRLiquidityRouter: routerAddress
    },
    external: {
      pythOracle: PYTH_ORACLE,
      sDAI: SDAI,
      xDAI: XDAI,
      uniswapV3Router: UNISWAP_V3_ROUTER
    }
  };

  const deploymentsDir = path.join(__dirname, "../../deployments");
  if (!fs.existsSync(deploymentsDir)) {
    fs.mkdirSync(deploymentsDir, { recursive: true });
  }

  const filename = path.join(deploymentsDir, "gnosis-deployment.json");
  fs.writeFileSync(filename, JSON.stringify(deploymentData, null, 2));
  console.log("\n✓ Deployment data saved to:", filename);
  
  console.log("\nNext steps:");
  console.log("1. Verify contracts: npm run verify:gnosis");
  console.log("2. Set up environment variables for LP node");
  console.log("3. Configure frontend with deployed addresses");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
