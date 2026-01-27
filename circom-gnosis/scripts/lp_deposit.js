const hre = require("hardhat");
const fs = require("fs");

async function main() {
    const DEPOSIT_AMOUNT = process.argv[2] || "1"; // Default 1 DAI
    
    console.log("💰 LP Collateral Deposit\n");
    console.log("═".repeat(70));

    // Load deployment
    const deployment = JSON.parse(fs.readFileSync('oracle/deployment.json', 'utf8'));
    console.log("\n📋 Contract:", deployment.bridge);

    // Get signer
    const [signer] = await hre.ethers.getSigners();
    console.log("👤 LP Address:", signer.address);

    // Connect to contracts
    const bridge = await hre.ethers.getContractAt("WrappedMonero", deployment.bridge);
    const dai = await hre.ethers.getContractAt("IERC20", await bridge.dai());

    // Parse amount
    const depositAmount = hre.ethers.parseUnits(DEPOSIT_AMOUNT, 18);
    console.log("\n💵 Deposit Amount:", DEPOSIT_AMOUNT, "DAI");

    // Check DAI balance
    const daiBalance = await dai.balanceOf(signer.address);
    console.log("   Current DAI Balance:", hre.ethers.formatUnits(daiBalance, 18), "DAI");
    
    if (daiBalance < depositAmount) {
        console.log("\n❌ Insufficient DAI balance!");
        console.log("   Need:", DEPOSIT_AMOUNT, "DAI");
        console.log("   Have:", hre.ethers.formatUnits(daiBalance, 18), "DAI");
        
        // Check if we need to wrap xDAI to WxDAI
        const ethBalance = await hre.ethers.provider.getBalance(signer.address);
        console.log("\n💡 You have", hre.ethers.formatEther(ethBalance), "xDAI");
        console.log("   Wrap xDAI to WxDAI first:");
        console.log("   1. Go to https://app.gnosischain.com/bridge");
        console.log("   2. Or use WxDAI contract: 0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d");
        return;
    }

    // Check current LP info
    const lpInfo = await bridge.lpInfo(signer.address);
    console.log("\n📊 Current LP Status:");
    console.log("   Collateral Shares:", hre.ethers.formatUnits(lpInfo.collateralShares, 18), "sDAI");
    console.log("   Backed Amount:", hre.ethers.formatUnits(lpInfo.backedAmount, 12), "XMR");

    // Check allowance
    const allowance = await dai.allowance(signer.address, deployment.bridge);
    if (allowance < depositAmount) {
        console.log("\n🔓 Approving DAI...");
        const approveTx = await dai.approve(deployment.bridge, depositAmount);
        console.log("   📝 TX Hash:", approveTx.hash);
        await approveTx.wait();
        console.log("   ✅ Approved");
    }

    // Deposit collateral
    console.log("\n💰 Depositing collateral...");
    try {
        const tx = await bridge.lpDeposit(depositAmount);
        
        console.log("   📝 TX Hash:", tx.hash);
        console.log("   ⏳ Waiting for confirmation...");
        
        const receipt = await tx.wait();
        console.log("   ✅ Confirmed in block", receipt.blockNumber);
        console.log("   ⛽ Gas used:", receipt.gasUsed.toString());
        
        // Show updated LP info
        const updatedLpInfo = await bridge.lpInfo(signer.address);
        const sDAI = await hre.ethers.getContractAt("IERC4626", await bridge.sDAI());
        const collateralValue = await sDAI.convertToAssets(updatedLpInfo.collateralShares);
        
        console.log("\n🎉 Deposit successful!");
        console.log("\n📊 Updated LP Status:");
        console.log("   Collateral Shares:", hre.ethers.formatUnits(updatedLpInfo.collateralShares, 18), "sDAI");
        console.log("   Collateral Value:", hre.ethers.formatUnits(collateralValue, 18), "DAI");
        console.log("   Backed Amount:", hre.ethers.formatUnits(updatedLpInfo.backedAmount, 12), "XMR");
        
        // Calculate available capacity
        const twapPrice = await bridge.twapPrice();
        const SAFE_RATIO = await bridge.SAFE_RATIO();
        const PICONERO_PER_XMR = await bridge.PICONERO_PER_XMR();
        
        const currentBackedValue = (updatedLpInfo.backedAmount * twapPrice) / (PICONERO_PER_XMR * BigInt(1e8));
        const maxBackedValue = (collateralValue * BigInt(100)) / SAFE_RATIO;
        const availableCapacity = maxBackedValue > currentBackedValue ? maxBackedValue - currentBackedValue : BigInt(0);
        
        console.log("\n💪 LP Capacity:");
        console.log("   Max Backed Value:", hre.ethers.formatUnits(maxBackedValue, 18), "USD");
        console.log("   Current Backed:", hre.ethers.formatUnits(currentBackedValue, 18), "USD");
        console.log("   Available Capacity:", hre.ethers.formatUnits(availableCapacity, 18), "USD");
        
        const MIN_MINT_BPS = await bridge.MIN_MINT_BPS();
        const minMintValue = (availableCapacity * MIN_MINT_BPS) / BigInt(10000);
        console.log("   Minimum Mint (1%):", hre.ethers.formatUnits(minMintValue, 18), "USD");
        
        console.log("\n📝 Next steps:");
        console.log("   1. Users can now create mint intents");
        console.log("   2. Send XMR to users' addresses");
        console.log("   3. Earn", hre.ethers.formatUnits(updatedLpInfo.mintFeeBps, 2), "% mint fee +", hre.ethers.formatUnits(updatedLpInfo.burnFeeBps, 2), "% burn fee");
        
    } catch (error) {
        console.log("\n❌ Deposit failed:");
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
