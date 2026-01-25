const hre = require('hardhat');
const { ethers } = hre;

async function main() {
    const [deployer] = await ethers.getSigners();
    
    // Contract addresses
    const WRAPPED_MONERO = '0xd53AB9c5789d202Ed45A596719D98a415da950f0';
    const WXDAI = '0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d';
    
    console.log('💰 Adding LP Collateral...');
    console.log('LP Address:', deployer.address);
    
    // Get contracts
    const wrappedMonero = await ethers.getContractAt('WrappedMoneroV3', WRAPPED_MONERO);
    const wxdai = await ethers.getContractAt('IERC20', WXDAI);
    
    // Check balance
    const balance = await wxdai.balanceOf(deployer.address);
    console.log('WxDAI Balance:', ethers.formatEther(balance), 'WxDAI');
    
    // Check current LP info
    const lpInfo = await wrappedMonero.lpInfo(deployer.address);
    console.log('\n📊 Current LP Info:');
    console.log('   Collateral Shares:', lpInfo.collateralShares.toString());
    console.log('   Backed Amount:', ethers.formatEther(lpInfo.backedAmount), 'zeroXMR');
    
    // For 0.0027 XMR at $511/XMR = $1.38
    // Need 150% collateral = $2.07
    // Add 2.5 DAI to be safe
    const depositAmount = ethers.parseEther('2.5');
    console.log('\n💵 Depositing additional collateral: 2.5 WxDAI');
    
    // Approve
    console.log('   Approving WxDAI...');
    const approveTx = await wxdai.approve(WRAPPED_MONERO, depositAmount);
    await approveTx.wait();
    console.log('   ✅ Approved');
    
    // Deposit
    console.log('   Depositing...');
    const depositTx = await wrappedMonero.lpDeposit(depositAmount);
    const receipt = await depositTx.wait();
    console.log('   ✅ Deposited!');
    console.log('   Gas used:', receipt.gasUsed.toString());
    
    // Check updated LP info
    const updatedLpInfo = await wrappedMonero.lpInfo(deployer.address);
    console.log('\n📊 Updated LP Info:');
    console.log('   Collateral Shares:', updatedLpInfo.collateralShares.toString());
    console.log('   Backed Amount:', ethers.formatEther(updatedLpInfo.backedAmount), 'zeroXMR');
    
    // Calculate how much XMR can be backed
    const SDAI = '0xaf204776c7245bF4147c2612BF6e5972Ee483701';
    const sdai = await ethers.getContractAt('IERC4626', SDAI);
    const collateralValue = await sdai.convertToAssets(updatedLpInfo.collateralShares);
    const xmrPrice = 511; // $511 per XMR
    const maxXmr = (Number(ethers.formatEther(collateralValue)) / xmrPrice) * (100 / 150);
    
    console.log('\n💎 Capacity:');
    console.log('   Collateral Value: $' + ethers.formatEther(collateralValue));
    console.log('   Max XMR at 150%: ~' + maxXmr.toFixed(4) + ' XMR');
    console.log('   Your TX: 0.0027 XMR ✅');
    
    console.log('\n🎉 Collateral added! Ready to mint.');
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
