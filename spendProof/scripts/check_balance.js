const hre = require('hardhat');
const { ethers } = hre;

async function main() {
    const [deployer] = await ethers.getSigners();
    const wrappedMonero = await ethers.getContractAt('WrappedMoneroV3', '0x25672720FfD4eD5967580c21a2fC30441E67d89B');
    
    const balance = await wrappedMonero.balanceOf(deployer.address);
    const totalSupply = await wrappedMonero.totalSupply();
    const decimals = await wrappedMonero.decimals();
    
    console.log('📊 Token Info:');
    console.log('   Your Balance:', ethers.formatUnits(balance, decimals), 'zeroXMR');
    console.log('   Total Supply:', ethers.formatUnits(totalSupply, decimals), 'zeroXMR');
    console.log('   Decimals:', decimals.toString());
    console.log();
    console.log('   Raw Balance:', balance.toString());
    console.log('   Raw Supply:', totalSupply.toString());
    
    // Check LP info
    const lpInfo = await wrappedMonero.lpInfo(deployer.address);
    console.log();
    console.log('📊 LP Info:');
    console.log('   Backed Amount:', ethers.formatUnits(lpInfo.backedAmount, decimals), 'XMR');
    console.log('   Collateral Shares:', ethers.formatUnits(lpInfo.collateralShares, 18));
}

main().catch(console.error);
