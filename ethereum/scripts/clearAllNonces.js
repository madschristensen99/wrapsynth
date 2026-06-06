#!/usr/bin/env node
require('dotenv').config();
const { ethers } = require('ethers');

async function main() {
    const provider = new ethers.providers.JsonRpcProvider('https://rpc.gnosischain.com');
    const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
    console.log('Wallet:', wallet.address);

    const latestNonce = await wallet.getTransactionCount('latest');
    const pendingNonce = await wallet.getTransactionCount('pending');
    console.log('Latest nonce:', latestNonce);
    console.log('Pending nonce:', pendingNonce);

    if (pendingNonce <= latestNonce) {
        console.log('No stuck transactions!');
        return;
    }

    console.log(`Clearing nonces ${latestNonce} to ${pendingNonce - 1}...`);
    for (let n = latestNonce; n < pendingNonce; n++) {
        console.log(`  Clearing nonce ${n}...`);
        try {
            const tx = await wallet.sendTransaction({
                to: wallet.address,
                value: 0,
                nonce: n,
                maxPriorityFeePerGas: ethers.utils.parseUnits('50', 'gwei'),
                maxFeePerGas: ethers.utils.parseUnits('100', 'gwei'),
                gasLimit: 21000
            });
            console.log(`    Sent: ${tx.hash}`);
            await tx.wait();
            console.log(`    Confirmed!`);
        } catch (err) {
            console.log(`    Error at nonce ${n}:`, err.reason || err.message);
        }
    }
    console.log('Done clearing nonces!');
}

main().catch(console.error);
