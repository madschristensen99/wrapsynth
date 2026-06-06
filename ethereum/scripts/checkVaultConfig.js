#!/usr/bin/env node
require('dotenv').config();
const { ethers } = require('ethers');

const HUB_ADDRESS = '0xd32e2ece901094550b81ab5051a72256761514d6';

async function main() {
    const provider = new ethers.providers.JsonRpcProvider('https://rpc.gnosischain.com');
    const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

    const hubAbi = [
        'function getVault(address lpAddress) external view returns (tuple(address lpAddress, uint256 collateralShares, uint256 lockedCollateral, uint256 normalizedDebt, uint256 pendingDebt, uint16 maxMintBps, uint256 mintGriefingDeposit, uint256 mintReadyBond, uint16 mintFeeBps, uint16 burnRewardBps, uint256 liquidationNonce, uint256 mintNonce, uint256 minBurnAmount, bool active, uint256 deployedSDAIShares, uint16 maxCoLPRangeBps))',
        'function getPositionMetadata(uint256 tokenId) external view returns (tuple(address vaultOwner, address user, uint256 sDAISharesOriginal, uint256 wsxmrOriginal, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 createdAt))'
    ];

    const hub = new ethers.Contract(HUB_ADDRESS, hubAbi, provider);

    const vault = await hub.getVault(wallet.address);
    console.log('Vault config:');
    console.log('  maxCoLPRangeBps:', vault.maxCoLPRangeBps);
    console.log('  collateralShares:', vault.collateralShares.toString());
    console.log('  lockedCollateral:', vault.lockedCollateral.toString());
    console.log('  deployedSDAIShares:', vault.deployedSDAIShares.toString());
    console.log('  active:', vault.active);

    const meta = await hub.getPositionMetadata(5477);
    console.log('\nPosition 5477 metadata:');
    console.log('  vaultOwner:', meta.vaultOwner);
    console.log('  user:', meta.user);
    console.log('  tickLower:', meta.tickLower);
    console.log('  tickUpper:', meta.tickUpper);
    console.log('  liquidity:', meta.liquidity.toString());
}

main().catch(console.error);
