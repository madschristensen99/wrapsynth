const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
  const networkName = hre.network.name;
  const networkDisplayName = networkName === "gnosis" ? "Gnosis Chain" : "Unichain Sepolia";
  const explorerUrl = networkName === "gnosis" ? "https://gnosisscan.io/address/" : "https://sepolia.uniscan.xyz/address/";
  
  console.log("════════════════════════════════════════════════════════════════");
  console.log(`  Contract Verification on ${networkDisplayName}`);
  console.log("════════════════════════════════════════════════════════════════\n");

  // Load latest deployment
  const deploymentsDir = path.join(__dirname, "..", "..", "deployments");
  const latestFile = path.join(deploymentsDir, `${networkName}_latest.json`);
  
  if (!fs.existsSync(latestFile)) {
    console.error("❌ No deployment file found. Please deploy first.");
    process.exit(1);
  }

  const deployment = JSON.parse(fs.readFileSync(latestFile, "utf8"));
  
  console.log("Loaded deployment:");
  console.log("  PlonkVerifier:", deployment.contracts.PlonkVerifier);
  console.log("  WrappedMonero:", deployment.contracts.WrappedMonero);
  console.log("");

  // ══════════════════════════════════════════════════════════════════════════
  // Verify PlonkVerifier
  // ══════════════════════════════════════════════════════════════════════════
  
  console.log("[1/2] Verifying PlonkVerifier...");
  try {
    await hre.run("verify:verify", {
      address: deployment.contracts.PlonkVerifier,
      constructorArguments: [],
    });
    console.log("✓ PlonkVerifier verified!");
  } catch (error) {
    if (error.message.includes("Already Verified")) {
      console.log("✓ PlonkVerifier already verified");
    } else {
      console.error("❌ Error verifying PlonkVerifier:", error.message);
    }
  }
  console.log("");

  // ══════════════════════════════════════════════════════════════════════════
  // Verify WrappedMonero
  // ══════════════════════════════════════════════════════════════════════════
  
  console.log("[2/2] Verifying WrappedMonero...");
  
  const constructorArgs = [
    deployment.contracts.PlonkVerifier,
    deployment.dependencies.sDAI || deployment.dependencies.wstETH, // Support both old and new deployments
    deployment.dependencies.pyth,
    deployment.initialMoneroBlock || 3605079, // Read from deployment file
  ];

  console.log("Constructor arguments:");
  console.log("  verifier:", constructorArgs[0]);
  console.log("  sDAI:", constructorArgs[1]);
  console.log("  pyth:", constructorArgs[2]);
  console.log("  initialMoneroBlock:", constructorArgs[3]);
  console.log("");

  try {
    await hre.run("verify:verify", {
      address: deployment.contracts.WrappedMonero,
      constructorArguments: constructorArgs,
    });
    console.log("✓ WrappedMonero verified!");
  } catch (error) {
    if (error.message.includes("Already Verified")) {
      console.log("✓ WrappedMonero already verified");
    } else {
      console.error("❌ Error verifying WrappedMonero:", error.message);
    }
  }

  console.log("\n════════════════════════════════════════════════════════════════");
  console.log("✓ Verification Complete!");
  console.log("════════════════════════════════════════════════════════════════\n");

  console.log(`View on ${networkDisplayName === "Gnosis Chain" ? "Gnosisscan" : "Uniscan"}:`);
  console.log("  PlonkVerifier:");
  console.log("    " + explorerUrl + deployment.contracts.PlonkVerifier);
  console.log("  WrappedMonero:");
  console.log("    " + explorerUrl + deployment.contracts.WrappedMonero);
  console.log("");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
