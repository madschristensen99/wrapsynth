const hre = require('hardhat');
const { ethers } = hre;

async function main() {
    const [deployer] = await ethers.getSigners();
    
    // Contract addresses
    const WRAPPED_MONERO = '0xd53AB9c5789d202Ed45A596719D98a415da950f0';
    const WXDAI = '0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d';
    
    console.log('🔮 Registering as LP...');
    console.log('LP Address:', deployer.address);
    console.log('LP XMR Address: 87G8STCTDVLXm3RYuTBUigPNY4N1yDroBBbDSEwME4w9ezDDcTJhXcSL6urUJiHJK2hADMyqweuMZgaK9fw2bF21CyAuQBQ');
    
    // Get contracts
    const wrappedMonero = await ethers.getContractAt('WrappedMoneroV3', WRAPPED_MONERO);
    const wxdai = await ethers.getContractAt('IERC20', WXDAI);
    
    // Check balance
    const balance = await wxdai.balanceOf(deployer.address);
    console.log('\n💰 WxDAI Balance:', ethers.formatEther(balance), 'WxDAI');
    
    // Register as LP
    // mintFeeBps: 50 (0.5%), burnFeeBps: 50 (0.5%), maxPendingIntents: 10, active: true
    console.log('\n📝 Registering LP...');
    console.log('   Mint Fee: 0.5% (50 bps)');
    console.log('   Burn Fee: 0.5% (50 bps)');
    console.log('   Max Pending Intents: 10');
    console.log('   Active: true');
    
    const registerTx = await wrappedMonero.registerLP(50, 50, 10, true);
    await registerTx.wait();
    console.log('✅ LP registered!');
    
    // Deposit 0.1 DAI collateral
    const depositAmount = ethers.parseEther('0.01'); // 0.01 DAI
    console.log('\n💵 Depositing collateral: 0.01 WxDAI');
    
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
    
    // Check LP info
    const lpInfo = await wrappedMonero.lpInfo(deployer.address);
    console.log('\n📊 LP Info:');
    console.log('   Collateral Shares:', lpInfo.collateralShares.toString());
    console.log('   Backed Amount:', ethers.formatEther(lpInfo.backedAmount), 'zeroXMR');
    console.log('   Mint Fee:', lpInfo.mintFeeBps.toString(), 'bps');
    console.log('   Burn Fee:', lpInfo.burnFeeBps.toString(), 'bps');
    console.log('   Max Pending Intents:', lpInfo.maxPendingIntents.toString());
    console.log('   Pending Intents:', lpInfo.pendingIntents.toString());
    console.log('   Active:', lpInfo.active);
    
    console.log('\n🎉 LP registration complete!');
    console.log('\n📝 Next steps:');
    console.log('1. Send XMR to: 87G8STCTDVLXm3RYuTBUigPNY4N1yDroBBbDSEwME4w9ezDDcTJhXcSL6urUJiHJK2hADMyqweuMZgaK9fw2bF21CyAuQBQ');
    console.log('2. Wait for transaction to confirm on Monero');
    console.log('3. Wait for oracle to post the block');
    console.log('4. Generate PLONK proof');
    console.log('5. Call mint() with proof');
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
