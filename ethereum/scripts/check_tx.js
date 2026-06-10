const { ethers } = require('ethers');

async function main() {
    const provider = new ethers.providers.JsonRpcProvider('https://rpc.gnosischain.com');
    const txHash = '0x24f20b072e8bf08dbd9cc4b2c44c94b7c59dde2a15f779f84388228b2b5efcb1';
    
    try {
        const receipt = await provider.getTransactionReceipt(txHash);
        if (receipt) {
            console.log('Status:', receipt.status === 1 ? 'SUCCESS' : 'REVERTED');
            console.log('Gas used:', receipt.gasUsed.toString());
            console.log('Block:', receipt.blockNumber);
        } else {
            console.log('TX not found or pending');
            const tx = await provider.getTransaction(txHash);
            if (tx) {
                console.log('TX found, waiting for confirmation...');
            }
        }
    } catch (err) {
        console.error('Error:', err.message);
    }
}
main().catch(console.error);
