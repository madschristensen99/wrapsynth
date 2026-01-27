const hre = require("hardhat");

async function main() {
    const OLD_CONTRACT = "0xD5351FdB8bea42f97D790353f7B72cDBb4b5a9CE";
    
    console.log("💸 LP Collateral Withdrawal\n");
    console.log("═".repeat(70));
    console.log("\n📋 Old Contract:", OLD_CONTRACT);

    // Get signer
    const [signer] = await hre.ethers.getSigners();
    console.log("👤 LP Address:", signer.address);

    // Connect to old contract
    const bridge = await hre.ethers.getContractAt("WrappedMonero", OLD_CONTRACT);

    // Check current LP info
    const lpInfo = await bridge.lpInfo(signer.address);
    console.log("\n📊 Current LP Status:");
    console.log("   Collateral Shares:", hre.ethers.formatUnits(lpInfo.collateralShares, 18), "sDAI");
    console.log("   Backed Amount:", hre.ethers.formatUnits(lpInfo.backedAmount, 12), "XMR");

    if (lpInfo.collateralShares == 0n) {
        console.log("\n✅ No collateral to withdraw");
        return;
    }

    // Get sDAI contract to check value
    const sDAI = await hre.ethers.getContractAt("IERC4626", await bridge.sDAI());
    const collateralValue = await sDAI.convertToAssets(lpInfo.collateralShares);
    console.log("   Collateral Value:", hre.ethers.formatUnits(collateralValue, 18), "DAI");

    // Withdraw all collateral
    console.log("\n💸 Withdrawing all collateral...");
    try {
        const tx = await bridge.lpWithdraw(lpInfo.collateralShares);
        
        console.log("   📝 TX Hash:", tx.hash);
        console.log("   ⏳ Waiting for confirmation...");
        
        const receipt = await tx.wait();
        console.log("   ✅ Confirmed in block", receipt.blockNumber);
        console.log("   ⛽ Gas used:", receipt.gasUsed.toString());
        
        console.log("\n🎉 Withdrawal successful!");
        console.log("   Received:", hre.ethers.formatUnits(collateralValue, 18), "WxDAI");
        
        // Check new balance
        const dai = await hre.ethers.getContractAt("IERC20", await bridge.dai());
        const newBalance = await dai.balanceOf(signer.address);
        console.log("   New WxDAI balance:", hre.ethers.formatUnits(newBalance, 18));
        
    } catch (error) {
        console.log("\n❌ Withdrawal failed:");
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
