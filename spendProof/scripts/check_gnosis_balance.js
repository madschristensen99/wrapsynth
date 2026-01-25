const { ethers } = require("hardhat");

async function main() {
    const [deployer] = await ethers.getSigners();
    
    console.log("\n🔍 Checking Gnosis Chain Balance\n");
    console.log("Wallet Address:", deployer.address);
    
    const balance = await ethers.provider.getBalance(deployer.address);
    console.log("xDAI Balance:", ethers.formatEther(balance), "xDAI");
    
    if (balance === 0n) {
        console.log("\n⚠️  No xDAI found!");
        console.log("\n📝 To get xDAI:");
        console.log("1. Bridge DAI: https://bridge.gnosischain.com");
        console.log("2. Or use faucet: https://gnosisfaucet.com");
        console.log("3. Send xDAI to:", deployer.address);
    } else {
        console.log("\n✅ Wallet has xDAI! Ready to deploy.");
        
        // Estimate deployment cost
        const estimatedGas = 2000000n; // ~2M gas for deployment
        const gasPrice = 2000000000n; // 2 gwei
        const estimatedCost = estimatedGas * gasPrice;
        
        console.log("\n💰 Estimated Deployment Cost:");
        console.log("Gas Estimate:", estimatedGas.toString(), "gas");
        console.log("Gas Price:", ethers.formatUnits(gasPrice, "gwei"), "gwei");
        console.log("Total Cost:", ethers.formatEther(estimatedCost), "xDAI");
        
        if (balance >= estimatedCost) {
            console.log("✅ Sufficient balance for deployment!");
        } else {
            console.log("⚠️  Balance may be insufficient. Need at least", ethers.formatEther(estimatedCost), "xDAI");
        }
    }
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
