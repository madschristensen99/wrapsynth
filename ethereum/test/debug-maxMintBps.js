// Debug script to trace maxMintBps calculation

const { ethers } = require("hardhat");

async function main() {
  console.log("=== maxMintBps Calculation Debug ===\n");

  // Test values from our test
  const collateralAmount = ethers.parseEther("50000"); // 50,000 DAI worth of sDAI shares
  const collateralPrice = ethers.parseUnits("1", 18); // $1.00 in 18 decimals
  const collateralDecimals = 18;
  const maxMintBps = 1; // 0.01%
  const BPS_DENOMINATOR = 10000;
  const RATIO_PRECISION = 100;
  const COLLATERAL_RATIO = 150;

  // Step 1: Calculate collateral value in USD
  const collateralValueUsd = (collateralAmount * collateralPrice) / (10n ** BigInt(collateralDecimals));
  console.log("1. Collateral Value USD:", ethers.formatUnits(collateralValueUsd, 18), "USD");

  // Step 2: Calculate max total debt capacity at 150% ratio
  const maxTotalDebtCapacity = (collateralValueUsd * BigInt(RATIO_PRECISION)) / BigInt(COLLATERAL_RATIO);
  console.log("2. Max Total Debt Capacity:", ethers.formatUnits(maxTotalDebtCapacity, 18), "USD");

  // Step 3: Calculate max mint allowed based on BPS
  const maxMintAllowed = (maxTotalDebtCapacity * BigInt(maxMintBps)) / BigInt(BPS_DENOMINATOR);
  console.log("3. Max Mint Allowed (0.01%):", ethers.formatUnits(maxMintAllowed, 18), "USD");

  // Convert to XMR amount at $160/XMR
  const xmrPrice = 160;
  const maxMintAllowedXMR = Number(ethers.formatUnits(maxMintAllowed, 18)) / xmrPrice;
  console.log("4. Max Mint Allowed in XMR:", maxMintAllowedXMR, "XMR");

  // Test amounts
  const testAmounts = [
    { xmr: 1, wsxmr: ethers.parseUnits("1", 8) },
    { xmr: 10, wsxmr: ethers.parseUnits("10", 8) },
    { xmr: 100, wsxmr: ethers.parseUnits("100", 8) },
  ];

  console.log("\n=== Testing Different Mint Amounts ===\n");

  for (const test of testAmounts) {
    // wsXMR is in 8 decimals, need to convert to USD value
    // At $160/XMR, 1 wsXMR = $160
    const wsxmrValueUSD = (test.wsxmr * BigInt(160)) / (10n ** 8n);
    const wsxmrValueUSD18Decimals = wsxmrValueUSD * (10n ** 18n);
    
    console.log(`Testing ${test.xmr} XMR (${ethers.formatUnits(test.wsxmr, 8)} wsXMR):`);
    console.log(`  - wsXMR value in USD: ${ethers.formatUnits(wsxmrValueUSD18Decimals, 18)} USD`);
    console.log(`  - Max allowed: ${ethers.formatUnits(maxMintAllowed, 18)} USD`);
    console.log(`  - Should revert: ${wsxmrValueUSD18Decimals > maxMintAllowed ? "YES" : "NO"}`);
    console.log();
  }

  console.log("\n=== Issue Analysis ===\n");
  console.log("The problem is that maxMintAllowed is calculated in USD (18 decimals)");
  console.log("but wsxmrAmount in the contract is in wsXMR units (8 decimals).");
  console.log("The comparison at line 510 compares wsXMR amount directly to USD value!");
  console.log("\nThis is a BUG in the contract logic.");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
