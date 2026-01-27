const hre = require("hardhat");
const fs = require("fs");

async function main() {
    console.log("🏦 Registering as Liquidity Provider\n");
    console.log("═".repeat(70));

    // Load deployment
    const deployment = JSON.parse(fs.readFileSync('oracle/deployment.json', 'utf8'));
    console.log("\n📋 Contract:", deployment.bridge);

    // Get signer
    const [signer] = await hre.ethers.getSigners();
    console.log("👤 LP Address:", signer.address);

    // Connect to contract
    const bridge = await hre.ethers.getContractAt("WrappedMonero", deployment.bridge);

    // LP Parameters
    const MINT_FEE_BPS = 50;  // 0.5% mint fee
    const BURN_FEE_BPS = 50;  // 0.5% burn fee
    const ACTIVE = true;  // Set LP as active
    
    // Monero address (any standard Monero address from your wallet)
    const MONERO_ADDRESS = process.env.MONERO_ADDRESS || "";
    
    if (!MONERO_ADDRESS) {
        console.error("\n❌ MONERO_ADDRESS not set!");
        console.error("   Set it in .env or pass as environment variable");
        process.exit(1);
    }

    console.log("\n⚙️  LP Configuration:");
    console.log("   Mint Fee:", MINT_FEE_BPS / 100, "%");
    console.log("   Burn Fee:", BURN_FEE_BPS / 100, "%");
    console.log("   Monero Address:", MONERO_ADDRESS);
    console.log("   Active:", ACTIVE);
    console.log("   Note: Minimum mint amount is 1% of LP capacity (Sybil defense)");

    // Check if already registered
    try {
        const lpInfo = await bridge.lpInfo(signer.address);
        if (lpInfo.active) {
            console.log("\n⚠️  Already registered as LP!");
            console.log("   Current Mint Fee:", lpInfo.mintFeeBps.toString(), "bps");
            console.log("   Current Burn Fee:", lpInfo.burnFeeBps.toString(), "bps");
            console.log("   Collateral Shares:", hre.ethers.formatUnits(lpInfo.collateralShares, 18));
            console.log("   Backed Amount:", hre.ethers.formatUnits(lpInfo.backedAmount, 12), "XMR");
            
            const response = await new Promise((resolve) => {
                const readline = require('readline').createInterface({
                    input: process.stdin,
                    output: process.stdout
                });
                readline.question('\nUpdate LP settings? (y/n): ', (answer) => {
                    readline.close();
                    resolve(answer.toLowerCase() === 'y');
                });
            });
            
            if (!response) {
                console.log("\n❌ Registration cancelled");
                return;
            }
        }
    } catch (error) {
        console.log("\n✅ Not yet registered as LP");
    }

    // Register as LP
    console.log("\n🚀 Registering as LP...");
    try {
        const tx = await bridge.registerLP(
            MINT_FEE_BPS,
            BURN_FEE_BPS,
            MONERO_ADDRESS,
            ACTIVE
        );
        
        console.log("   📝 TX Hash:", tx.hash);
        console.log("   ⏳ Waiting for confirmation...");
        
        const receipt = await tx.wait();
        console.log("   ✅ Confirmed in block", receipt.blockNumber);
        console.log("   ⛽ Gas used:", receipt.gasUsed.toString());
        
        console.log("\n🎉 Successfully registered as LP!");
        
        // Show updated LP info
        const lpInfo = await bridge.lpInfo(signer.address);
        console.log("\n📊 LP Info:");
        console.log("   Mint Fee:", lpInfo.mintFeeBps.toString(), "bps (", Number(lpInfo.mintFeeBps) / 100, "%)");
        console.log("   Burn Fee:", lpInfo.burnFeeBps.toString(), "bps (", Number(lpInfo.burnFeeBps) / 100, "%)");
        console.log("   Monero Address:", lpInfo.moneroAddress);
        console.log("   Active:", lpInfo.active);
        console.log("   Collateral Shares:", hre.ethers.formatUnits(lpInfo.collateralShares, 18), "sDAI");
        console.log("   Backed Amount:", hre.ethers.formatUnits(lpInfo.backedAmount, 12), "XMR");
        
        console.log("\n📝 Next steps:");
        console.log("   1. Deposit collateral: node scripts/lp_deposit.js");
        console.log("   2. Wait for users to create mint intents");
        console.log("   3. Send XMR to users and fulfill intents");
        
    } catch (error) {
        console.log("\n❌ Registration failed:");
        console.log("   Error:", error.message);
        if (error.data) {
            console.log("   Data:", error.data);
        }
    }
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
