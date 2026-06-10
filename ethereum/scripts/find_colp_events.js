const { ethers } = require('ethers');

const HUB = '0xaF04319B462850Fa645EaDE5C816b4dC894d9575';
const VAULT = '0x492c0b9F298cC49FE2644a2EBc6eA8dF848c72FB';

async function main() {
    const provider = new ethers.providers.JsonRpcProvider('https://rpc.gnosischain.com');
    
    // CoLPDeployed event signature with indexed params
    const topic0 = ethers.utils.id('CoLPDeployed(address,address,uint256,uint256,uint256,uint16)');
    const vaultTopic = ethers.utils.hexZeroPad(VAULT, 32);
    
    console.log('Searching for CoLPDeployed events for vault...');
    
    const logs = await provider.getLogs({
        address: HUB,
        fromBlock: 35000000,
        toBlock: 'latest',
        topics: [topic0, vaultTopic]
    });
    
    console.log('Found', logs.length, 'CoLPDeployed events');
    
    const abi = ['event CoLPDeployed(address indexed vault, address indexed user, uint256 indexed tokenId, uint256 daiAmount, uint256 wsxmrAmount, uint16 rangeBps)'];
    const iface = new ethers.utils.Interface(abi);
    
    for (const log of logs) {
        const parsed = iface.parseLog(log);
        console.log('TokenId:', parsed.args.tokenId.toString(), 
                    'User:', parsed.args.user,
                    'DAI:', ethers.utils.formatEther(parsed.args.daiAmount),
                    'wsXMR:', ethers.utils.formatUnits(parsed.args.wsxmrAmount, 8),
                    'Block:', log.blockNumber);
    }
    
    // Also search for CoLPUnwound
    const topic0unwound = ethers.utils.id('CoLPUnwound(uint256,address,address,uint256,uint256,bool)');
    const logsUnwound = await provider.getLogs({
        address: HUB,
        fromBlock: 35000000,
        toBlock: 'latest',
        topics: [topic0unwound]
    });
    console.log('\nFound', logsUnwound.length, 'CoLPUnwound events');
}
main().catch(console.error);
