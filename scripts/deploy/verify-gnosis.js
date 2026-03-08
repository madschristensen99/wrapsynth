const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
  console.log("Starting Gnosis Chain contract verification...\n");

  const deploymentFile = path.join(__dirname, "../../deployments/gnosis-deployment.json");
  
  if (!fs.existsSync(deploymentFile)) {
    console.error("Error: Deployment file not found at", deploymentFile);
    console.error("Please run deployment first: npm run deploy:gnosis");
    process.exit(1);
  }

  const deployment = JSON.parse(fs.readFileSync(deploymentFile, "utf8"));
  
  console.log("Loaded deployment data:");
  console.log("  wsXMR:", deployment.contracts.wsXMR);
  console.log("  VaultManager:", deployment.contracts.VaultManager);
  console.log("  wsXMRLiquidityRouter:", deployment.contracts.wsXMRLiquidityRouter);
  console.log();

  const PYTH_ORACLE = deployment.external.pythOracle;
  const UNISWAP_V3_POSITION_MANAGER = "0xC36442b4a4522E871399CD717aBDD847Ab11FE88";

  console.log("=".repeat(60));
  console.log("Verifying wsXMR Token");
  console.log("=".repeat(60));
  console.log("Note: wsXMR is deployed by VaultManager constructor");
  console.log("Constructor args: none (VaultManager is set as deployer)");
  
  try {
    await hre.run("verify:verify", {
      address: deployment.contracts.wsXMR,
      constructorArguments: [],
    });
    console.log("✓ wsXMR verified successfully\n");
  } catch (error) {
    if (error.message.includes("Already Verified")) {
      console.log("✓ wsXMR already verified\n");
    } else {
      console.error("✗ wsXMR verification failed:", error.message, "\n");
    }
  }

  console.log("=".repeat(60));
  console.log("Verifying VaultManager");
  console.log("=".repeat(60));
  
  try {
    await hre.run("verify:verify", {
      address: deployment.contracts.VaultManager,
      constructorArguments: [PYTH_ORACLE],
    });
    console.log("✓ VaultManager verified successfully\n");
  } catch (error) {
    if (error.message.includes("Already Verified")) {
      console.log("✓ VaultManager already verified\n");
    } else {
      console.error("✗ VaultManager verification failed:", error.message, "\n");
    }
  }

  console.log("=".repeat(60));
  console.log("Verifying wsXMRLiquidityRouter");
  console.log("=".repeat(60));
  
  try {
    await hre.run("verify:verify", {
      address: deployment.contracts.wsXMRLiquidityRouter,
      constructorArguments: [
        deployment.contracts.VaultManager,
        deployment.contracts.wsXMR,
        UNISWAP_V3_POSITION_MANAGER
      ],
    });
    console.log("✓ wsXMRLiquidityRouter verified successfully\n");
  } catch (error) {
    if (error.message.includes("Already Verified")) {
      console.log("✓ wsXMRLiquidityRouter already verified\n");
    } else {
      console.error("✗ wsXMRLiquidityRouter verification failed:", error.message, "\n");
    }
  }

  console.log("=".repeat(60));
  console.log("VERIFICATION COMPLETE");
  console.log("=".repeat(60));
  console.log("View contracts on Gnosisscan:");
  console.log("  wsXMR:", `https://gnosisscan.io/address/${deployment.contracts.wsXMR}`);
  console.log("  VaultManager:", `https://gnosisscan.io/address/${deployment.contracts.VaultManager}`);
  console.log("  wsXMRLiquidityRouter:", `https://gnosisscan.io/address/${deployment.contracts.wsXMRLiquidityRouter}`);
  console.log("=".repeat(60));
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
