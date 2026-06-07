require('dotenv').config();
const { ethers } = require('ethers');
const fs = require('fs');

async function main() {
    const provider = new ethers.providers.JsonRpcProvider('https://rpc.gnosischain.com');
    const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
    
    const artifact = JSON.parse(fs.readFileSync('out/SwapHelper.sol/SwapHelper.json'));
    const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode.object, wallet);
    
    console.log('Deploying SwapHelper...');
    const contract = await factory.deploy({
        maxPriorityFeePerGas: ethers.utils.parseUnits('10', 'gwei'),
        maxFeePerGas: ethers.utils.parseUnits('20', 'gwei')
    });
    
    await contract.deployed();
    console.log('SwapHelper deployed to:', contract.address);
}

main().catch(console.error);
