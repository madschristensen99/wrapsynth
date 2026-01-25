const hre = require('hardhat');
const { ethers } = hre;

async function main() {
    const wrappedMonero = await ethers.getContractAt('WrappedMoneroV3', '0xe1B76b604F12Fd20b8D490C4C1f0634521626B0B');
    const latestBlock = await wrappedMonero.latestMoneroBlock();
    console.log('📦 Contract latestMoneroBlock:', latestBlock.toString());
    console.log('🎯 Our TX is in block: 3595150');
    console.log('📊 Blocks posted by oracle:', (latestBlock - 3595150n).toString());
}

main().catch(console.error);
