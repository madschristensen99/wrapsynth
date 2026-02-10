const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
  console.log("════════════════════════════════════════════════════════════════");
  console.log("  Create Mint Intent");
  console.log("════════════════════════════════════════════════════════════════\n");

  const deployment = JSON.parse(fs.readFileSync(path.join(__dirname, "../deployments/unichain_testnet_mock_latest.json")));
  const [signer] = await hre.ethers.getSigners();
  
  console.log("User:", signer.address);
  console.log("Contract:", deployment.contracts.WrappedMonero);
  console.log("");

  const WrappedMonero = await hre.ethers.getContractAt("WrappedMonero", deployment.contracts.WrappedMonero);

  // Create mint intent for 0.00125 XMR = 1,250,000,000 piconero
  // Note: parseUnits with 12 decimals doesn't work correctly for small amounts
  const expectedAmount = BigInt(1250000000); // 0.00125 XMR in piconero
  const intentDeposit = hre.ethers.parseEther("0.001"); // 0.001 ETH anti-griefing deposit
  const lpAddress = signer.address; // Using self as LP for testing

  console.log("Creating mint intent:");
  console.log("  LP:", lpAddress);
  console.log("  Expected amount:", hre.ethers.formatUnits(expectedAmount, 12), "XMR");
  console.log("  Intent deposit:", hre.ethers.formatEther(intentDeposit), "ETH");
  console.log("");

  try {
    const tx = await WrappedMonero.createMintIntent(
      lpAddress,
      expectedAmount,
      { value: intentDeposit }
    );
    
    console.log("  TX:", tx.hash);
    const receipt = await tx.wait();
    
    // Get intent ID from event
    const event = receipt.logs.find(log => {
      try {
        return WrappedMonero.interface.parseLog(log).name === "MintIntentCreated";
      } catch {
        return false;
      }
    });
    
    if (event) {
      const parsed = WrappedMonero.interface.parseLog(event);
      const intentId = parsed.args.intentId;
      console.log("✓ Mint intent created!");
      console.log("  Intent ID:", intentId);
      console.log("");
      console.log("Now you can proceed with proof generation and minting.");
    }
  } catch (error) {
    console.error("❌ Error:", error.message);
    if (error.reason) {
      console.error("   Reason:", error.reason);
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
