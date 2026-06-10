#!/usr/bin/env node
require('dotenv').config();
const { ethers } = require('ethers');
const { HUB_ADDRESS } = require('./deploymentConfig');

async function main() {
    const provider = new ethers.providers.JsonRpcProvider('https://rpc.gnosischain.com');
    const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
    
    const hub = new ethers.Contract(HUB_ADDRESS, [
        'function getVault(address) view returns (tuple(address lpAddress, uint256 collateralShares, uint256 lockedCollateral, uint256 normalizedDebt, uint256 pendingDebt, uint16 maxMintBps, uint256 mintGriefingDeposit, uint256 mintReadyBond, uint16 mintFeeBps, uint16 burnRewardBps, uint256 liquidationNonce, uint256 mintNonce, uint256 minBurnAmount, bool active, uint256 deployedSDAIShares, uint16 maxCoLPRangeBps, uint256 mintTimeoutBlocks, uint256 burnTimeoutBlocks))',
        'function unwindCoLP(uint256 tokenId, uint256 deadline) external',
        'function getPositionMetadata(uint256) view returns (tuple(address vaultOwner, address user, uint256 sDAISharesOriginal, uint256 wsxmrOriginal, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 createdAt))',
        'event CoLPDeployed(address indexed vault, address indexed user, uint256 indexed tokenId, uint256 sDAIShares, uint256 wsxmrAmount, uint16 rangeBps)',
        'event CoLPUnwound(uint256 indexed tokenId, address indexed vault, address indexed user, uint256 daiReturned, uint256 wsxmrReturned, bool liquidationTriggered)'
    ], wallet);
    
    console.log('Vault:', wallet.address);
    console.log('Hub:', HUB_ADDRESS);
    console.log('');
    
    // Get vault state
    const vault = await hub.getVault(wallet.address);
    console.log('Deployed sDAI shares:', ethers.utils.formatEther(vault.deployedSDAIShares));
    
    if (vault.deployedSDAIShares.eq(0)) {
        console.log('No CoLP positions to unwind');
        return;
    }
    
    // Find CoLP positions from events
    console.log('Searching for CoLP positions from events...');
    const deployFilter = hub.filters.CoLPDeployed(wallet.address);
    const unwindFilter = hub.filters.CoLPUnwound(null, wallet.address);
    
    const deployEvents = await hub.queryFilter(deployFilter, 0, 'latest');
    const unwindEvents = await hub.queryFilter(unwindFilter, 0, 'latest');
    
    const unwoundTokenIds = new Set(unwindEvents.map(e => e.args.tokenId.toString()));
    const activeTokenIds = deployEvents
        .map(e => e.args.tokenId)
        .filter(tokenId => !unwoundTokenIds.has(tokenId.toString()));
    
    console.log(`Found ${activeTokenIds.length} active positions`);
    
    if (activeTokenIds.length === 0) {
        console.log('⚠️  No active positions found in events, but vault shows deployed sDAI.');
        console.log('   This might be a state inconsistency.');
        return;
    }
    
    // Unwind each position
    const deadline = Math.floor(Date.now() / 1000) + 3600;
    
    for (const tokenId of activeTokenIds) {
        try {
            const meta = await hub.getPositionMetadata(tokenId);
            
            // Check if position still exists
            if (meta.vaultOwner === ethers.constants.AddressZero) {
                console.log(`Position ${tokenId} already unwound (metadata cleared)`);
                continue;
            }
            
            console.log(`Unwinding position ${tokenId}...`);
            console.log(`  sDAI shares: ${ethers.utils.formatEther(meta.sDAISharesOriginal)}`);
            console.log(`  wsXMR: ${ethers.utils.formatUnits(meta.wsxmrOriginal, 8)}`);
            
            const tx = await hub.unwindCoLP(tokenId, deadline, { gasLimit: 1000000 });
            console.log('  TX:', tx.hash);
            await tx.wait();
            console.log('  ✅ Unwound');
        } catch (err) {
            console.log(`  ❌ Failed to unwind ${tokenId}:`, err.reason || err.message);
        }
    }
    
    // Check final state
    const vaultAfter = await hub.getVault(wallet.address);
    console.log('');
    console.log('Final vault state:');
    console.log('  Collateral Shares:', ethers.utils.formatEther(vaultAfter.collateralShares));
    console.log('  Deployed sDAI:', ethers.utils.formatEther(vaultAfter.deployedSDAIShares));
}

main().catch(console.error);
