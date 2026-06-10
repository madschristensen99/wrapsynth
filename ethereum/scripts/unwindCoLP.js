#!/usr/bin/env node
require('dotenv').config();
const { ethers } = require('ethers');
const { WrapperBuilder } = require('@redstone-finance/evm-connector');
const { getSignersForDataServiceId } = require('@redstone-finance/oracles-smartweave-contracts');

const { HUB_ADDRESS } = require('./deploymentConfig');

async function main() {
    const provider = new ethers.providers.JsonRpcProvider('https://rpc.gnosischain.com');
    const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
    
    const hub = new ethers.Contract(HUB_ADDRESS, [
        'function getVault(address) view returns (tuple(address lpAddress, uint256 collateralShares, uint256 lockedCollateral, uint256 normalizedDebt, uint256 pendingDebt, uint16 maxMintBps, uint256 mintGriefingDeposit, uint256 mintReadyBond, uint16 mintFeeBps, uint16 burnRewardBps, uint256 liquidationNonce, uint256 mintNonce, uint256 minBurnAmount, bool active, uint256 deployedSDAIShares, uint16 maxCoLPRangeBps, uint256 mintTimeoutBlocks, uint256 burnTimeoutBlocks))',
        'function unwindCoLP(uint256 tokenId, uint256 deadline) external',
        'function getVaultPositions(address) view returns (uint256[])',
        'function getPositionMetadata(uint256) view returns (tuple(address vaultOwner, address user, uint256 sDAISharesOriginal, uint256 wsxmrOriginal, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 createdAt))',
        'function updateOraclePrices(bytes[] calldata) external payable',
    ], wallet);
    
    console.log('Vault:', wallet.address);
    
    // Update prices first
    const authorizedSigners = getSignersForDataServiceId("redstone-primary-prod");
    const wrappedHub = WrapperBuilder.wrap(hub).usingDataService({
        dataServiceId: "redstone-primary-prod",
        uniqueSignersCount: 3,
        dataPackagesIds: ["XMR", "DAI"],
        authorizedSigners
    });
    
    console.log('Updating prices...');
    const priceTx = await wrappedHub.updateOraclePrices([]);
    await priceTx.wait();
    console.log('Prices updated');
    
    // Get positions
    const positions = await hub.getVaultPositions(wallet.address);
    console.log('CoLP positions:', positions.length);
    
    if (positions.length === 0) {
        console.log('No CoLP positions to unwind');
        return;
    }
    
    for (let i = 0; i < positions.length; i++) {
        const tokenId = positions[i];
        const meta = await hub.getPositionMetadata(tokenId);
        console.log(`Unwinding position ${tokenId}...`);
        console.log(`  sDAI shares: ${ethers.utils.formatEther(meta.sDAISharesOriginal)}`);
        console.log(`  wsXMR: ${ethers.utils.formatUnits(meta.wsxmrOriginal, 8)}`);
        
        const deadline = Math.floor(Date.now() / 1000) + 3600;
        const tx = await hub.unwindCoLP(tokenId, deadline, { gasLimit: 1000000 });
        console.log('TX:', tx.hash);
        await tx.wait();
        console.log('✅ Unwound');
    }
    
    const v = await hub.getVault(wallet.address);
    console.log('');
    console.log('New vault state:');
    console.log('  Collateral Shares:', ethers.utils.formatEther(v.collateralShares));
    console.log('  Deployed sDAI:', ethers.utils.formatEther(v.deployedSDAIShares));
}

main().catch(console.error);
