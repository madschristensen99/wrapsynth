#!/usr/bin/env node
require('dotenv').config();
const { ethers } = require('ethers');

const HUB = '0x1fb8E7593B01bCdAE13e5b63e529f0e30a3ebD50';
const XDAI = '0xe91D153E0b41518A2Ce8Dd3D7944fA863463a97d';

async function main() {
    const provider = new ethers.providers.JsonRpcProvider('https://rpc.gnosischain.com');
    const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
    
    const hub = new ethers.Contract(HUB, [
        'function depositCollateral(uint256 amount) external',
        'function getVault(address) view returns (tuple(address lpAddress, uint256 collateralShares, uint256 lockedCollateral, uint256 normalizedDebt, uint256 pendingDebt, uint16 maxMintBps, uint256 mintGriefingDeposit, uint256 mintReadyBond, uint16 mintFeeBps, uint16 burnRewardBps, uint256 liquidationNonce, uint256 mintNonce, uint256 minBurnAmount, bool active, uint256 deployedSDAIShares, uint16 maxCoLPRangeBps, uint256 mintTimeoutBlocks, uint256 burnTimeoutBlocks))',
        'function getVaultHealth(address) view returns (uint256)',
    ], wallet);
    
    const xdai = new ethers.Contract(XDAI, [
        'function balanceOf(address) view returns (uint256)',
        'function approve(address,uint256) external returns (bool)',
        'function decimals() view returns (uint8)',
    ], wallet);
    
    const balance = await xdai.balanceOf(wallet.address);
    console.log('xDAI balance:', ethers.utils.formatEther(balance));
    
    const health = await hub.getVaultHealth(wallet.address);
    console.log('Current Health:', (health / 10).toFixed(1) + '%');
    
    // Deposit 1 xDAI (or adjust as needed)
    const depositAmount = ethers.utils.parseEther('1.0');
    
    if (balance.lt(depositAmount)) {
        console.log('❌ Not enough xDAI');
        return;
    }
    
    console.log('Approving xDAI...');
    const approveTx = await xdai.approve(HUB, depositAmount);
    await approveTx.wait();
    
    console.log('Depositing', ethers.utils.formatEther(depositAmount), 'xDAI...');
    const tx = await hub.depositCollateral(depositAmount, { gasLimit: 500000 });
    console.log('TX:', tx.hash);
    await tx.wait();
    
    const newHealth = await hub.getVaultHealth(wallet.address);
    console.log('New Health:', (newHealth / 10).toFixed(1) + '%');
    console.log('✅ Done');
}

main().catch(console.error);
