#!/usr/bin/env node
require('dotenv').config();
const { ethers } = require('ethers');

const HUB_ADDRESS = '0xf873f64360c2214feb5cf7d7b542a6a3ca6a3afb';

async function main() {
    const provider = new ethers.providers.JsonRpcProvider('https://rpc.gnosischain.com');
    const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
    
    console.log('💰 Claiming Burn Rewards');
    console.log('========================');
    console.log('Wallet:', wallet.address);
    console.log('');
    
    const hubAbi = [
        'function getPendingReturns(address user, address token) external view returns (uint256)',
        'function withdrawReturns(address token) external'
    ];
    
    const hub = new ethers.Contract(HUB_ADDRESS, hubAbi, wallet);
    
    // Check pending returns (burn rewards are stored with hub address as token)
    const pendingReward = await hub.getPendingReturns(wallet.address, HUB_ADDRESS);
    
    console.log('Pending Burn Reward:', ethers.utils.formatEther(pendingReward), 'sDAI');
    
    if (pendingReward.eq(0)) {
        console.log('✅ No pending rewards to claim');
        return;
    }
    
    console.log('');
    console.log('📤 Claiming rewards...');
    const claimTx = await hub.withdrawReturns(HUB_ADDRESS);
    console.log('TX:', claimTx.hash);
    await claimTx.wait();
    console.log('✅ Rewards claimed!');
    console.log('');
    
    const remainingReward = await hub.getPendingReturns(wallet.address, HUB_ADDRESS);
    console.log('Remaining Pending:', ethers.utils.formatEther(remainingReward), 'sDAI');
}

main().catch(console.error);
