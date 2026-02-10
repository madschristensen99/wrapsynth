const hre = require('hardhat');

async function main() {
  const [signer] = await hre.ethers.getSigners();
  const bridge = await hre.ethers.getContractAt('WrappedMonero', '0x908728E13c8106cB969a652c34A587b45fE2CB55');
  const lpInfo = await bridge.lpInfo(signer.address);
  
  console.log('\n════════════════════════════════════════════════════════════════');
  console.log('LP Information');
  console.log('════════════════════════════════════════════════════════════════\n');
  console.log('LP Address:', signer.address);
  console.log('LP Monero Address:', lpInfo.moneroAddress);
  console.log('LP Private View Key:', lpInfo.privateViewKey);
  console.log('LP Active:', lpInfo.active);
  console.log('LP Collateral:', hre.ethers.formatEther(lpInfo.collateralAmount), 'wstETH');
  console.log('LP Backed Amount:', lpInfo.backedAmount.toString(), 'piconero');
  console.log('\n════════════════════════════════════════════════════════════════\n');
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
