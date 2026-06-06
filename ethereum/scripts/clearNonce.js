#!/usr/bin/env node
require('dotenv').config();
const { ethers } = require('ethers');

async function main() {
    const provider = new ethers.providers.JsonRpcProvider('https://rpc.gnosischain.com');
    const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
    console.log('Wallet:', wallet.address);

    const nonce = await wallet.getTransactionCount('pending');
    console.log('Pending nonce:', nonce);

    console.log('Sending dummy tx to clear nonce', nonce - 1, '...');
    const tx = await wallet.sendTransaction({
        to: wallet.address,
        value: 0,
        nonce: nonce - 1,
        maxPriorityFeePerGas: ethers.utils.parseUnits('10', 'gwei'),
        maxFeePerGas: ethers.utils.parseUnits('20', 'gwei'),
        gasLimit: 21000
    });
    console.log('Sent:', tx.hash);
    await tx.wait();
    console.log('Confirmed! Nonce cleared.');
}

main().catch(console.error);
