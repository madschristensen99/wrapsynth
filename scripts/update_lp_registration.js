const hre = require('hardhat');

async function main() {
  console.log('════════════════════════════════════════════════════════════════');
  console.log('  Updating LP Registration with Real Monero Wallet');
  console.log('════════════════════════════════════════════════════════════════\n');

  const [signer] = await hre.ethers.getSigners();
  const bridge = await hre.ethers.getContractAt('WrappedMonero', '0x908728E13c8106cB969a652c34A587b45fE2CB55');

  const mintFeeBps = 50;  // 0.5%
  const burnFeeBps = 50;  // 0.5%
  const moneroAddress = "88J4PFznDQNXWdTzfFggdP955vafWQMSDVpXvgPZCt7pYJWfnuVP9WzjHS9xf16L28iE7uw7LncFUeJuNXB55DP1GdrP6p7";
  const privateViewKey = "0x0ca8606d02e81ddd102068ae432e00a2510c07f531df440af886788139c3dd04";
  const active = true;

  console.log('Configuration:');
  console.log('  Mint Fee:', mintFeeBps / 100, '%');
  console.log('  Burn Fee:', burnFeeBps / 100, '%');
  console.log('  Monero Address:', moneroAddress);
  console.log('  Private View Key:', privateViewKey.slice(0, 18) + '...');
  console.log('');

  console.log('Updating LP registration...');
  const tx = await bridge.registerLP(mintFeeBps, burnFeeBps, moneroAddress, privateViewKey, active);
  console.log('  TX:', tx.hash);
  await tx.wait();
  console.log('✓ LP registration updated!\n');

  // Verify
  const lpInfo = await bridge.lpInfo(signer.address);
  console.log('Verified LP Info:');
  console.log('  Monero Address:', lpInfo.moneroAddress);
  console.log('  Private View Key:', lpInfo.privateViewKey);
  console.log('  Active:', lpInfo.active);
  console.log('');
  console.log('✅ LP is now configured with your real Monero wallet!');
  console.log('');
  console.log('Next: Send XMR to this address and provide transaction details.');
  console.log('');
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
