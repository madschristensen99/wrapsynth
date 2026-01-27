const hre = require("hardhat");

async function main() {
    const WRAP_AMOUNT = process.argv[2] || "1"; // Default 1 xDAI
    
    console.log("🔄 Wrapping xDAI to WxDAI\n");
    console.log("═".repeat(70));

    // Get signer
    const [signer] = await hre.ethers.getSigners();
    console.log("\n👤 Address:", signer.address);

    // WxDAI contract (WETH-like wrapper)
    const WXDAI_ADDRESS = "0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d";
    const wxdai = await hre.ethers.getContractAt(
        ["function deposit() payable", "function balanceOf(address) view returns (uint256)"],
        WXDAI_ADDRESS
    );

    // Parse amount
    const wrapAmount = hre.ethers.parseEther(WRAP_AMOUNT);
    console.log("💵 Wrap Amount:", WRAP_AMOUNT, "xDAI");

    // Check balances
    const xdaiBalance = await hre.ethers.provider.getBalance(signer.address);
    const wxdaiBalance = await wxdai.balanceOf(signer.address);
    
    console.log("\n📊 Current Balances:");
    console.log("   xDAI:", hre.ethers.formatEther(xdaiBalance));
    console.log("   WxDAI:", hre.ethers.formatEther(wxdaiBalance));

    if (xdaiBalance < wrapAmount) {
        console.log("\n❌ Insufficient xDAI balance!");
        return;
    }

    // Wrap xDAI
    console.log("\n🔄 Wrapping xDAI...");
    try {
        const tx = await wxdai.deposit({ value: wrapAmount });
        
        console.log("   📝 TX Hash:", tx.hash);
        console.log("   ⏳ Waiting for confirmation...");
        
        const receipt = await tx.wait();
        console.log("   ✅ Confirmed in block", receipt.blockNumber);
        console.log("   ⛽ Gas used:", receipt.gasUsed.toString());
        
        // Show updated balances
        const newXdaiBalance = await hre.ethers.provider.getBalance(signer.address);
        const newWxdaiBalance = await wxdai.balanceOf(signer.address);
        
        console.log("\n🎉 Wrap successful!");
        console.log("\n📊 Updated Balances:");
        console.log("   xDAI:", hre.ethers.formatEther(newXdaiBalance));
        console.log("   WxDAI:", hre.ethers.formatEther(newWxdaiBalance));
        
        console.log("\n📝 Next step:");
        console.log("   Run: npx hardhat run scripts/lp_deposit.js --network gnosis");
        
    } catch (error) {
        console.log("\n❌ Wrap failed:");
        console.log("   Error:", error.message);
    }
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
