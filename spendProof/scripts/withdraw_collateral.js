const hre = require('hardhat');
const { ethers } = hre;

async function main() {
    const [deployer] = await ethers.getSigners();
    
    const WRAPPED_MONERO = '0x25672720FfD4eD5967580c21a2fC30441E67d89B';
    const wrappedMonero = await ethers.getContractAt('WrappedMoneroV3', WRAPPED_MONERO);
    
    console.log('💰 Withdrawing LP Collateral\n');
    console.log('Contract:', WRAPPED_MONERO);
    console.log('LP Address:', deployer.address);
    console.log();
    
    // Check current LP info
    const lpInfo = await wrappedMonero.lpInfo(deployer.address);
    console.log('📊 Current LP Info:');
    console.log('   Active:', lpInfo.active);
    console.log('   Collateral Shares:', ethers.formatUnits(lpInfo.collateralShares, 18));
    console.log('   Backed Amount:', ethers.formatUnits(lpInfo.backedAmount, 12), 'XMR');
    console.log();
    
    if (lpInfo.collateralShares > 0n) {
        console.log('🚀 Withdrawing collateral...');
        const tx = await wrappedMonero.lpWithdraw(lpInfo.collateralShares);
        console.log('   TX:', tx.hash);
        await tx.wait();
        console.log('✅ Collateral withdrawn!');
        console.log();
        
        // Check balance
        const balance = await ethers.provider.getBalance(deployer.address);
        console.log('💵 Your balance:', ethers.formatEther(balance), 'xDAI');
    } else {
        console.log('⚠️  No collateral to withdraw');
    }
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
