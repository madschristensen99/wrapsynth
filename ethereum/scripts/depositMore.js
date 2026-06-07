#!/usr/bin/env node
require('dotenv').config();
const { ethers } = require('ethers');
const { WrapperBuilder } = require('@redstone-finance/evm-connector');
const { getSignersForDataServiceId } = require('@redstone-finance/oracles-smartweave-contracts');

async function main() {
    const provider = new ethers.providers.JsonRpcProvider('https://rpc.gnosischain.com');
    const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
    
    const HUB_ADDRESS = '0xb278a9124afa6751911cfffac777ef4930b1a29e';
    const WXDAI_ADDRESS = '0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d';
    
    const wxdaiAbi = ['function deposit() external payable', 'function approve(address,uint256) external returns (bool)', 'function balanceOf(address) external view returns (uint256)'];
    const hubAbi = [
        'function depositCollateral(uint256 amount) external',
        'function updateOraclePrices(bytes[] calldata updateData) external payable'
    ];
    
    const wxdai = new ethers.Contract(WXDAI_ADDRESS, wxdaiAbi, wallet);
    const hub = new ethers.Contract(HUB_ADDRESS, hubAbi, wallet);
    
    const authorizedSigners = getSignersForDataServiceId('redstone-primary-prod');
    const wrappedHub = WrapperBuilder.wrap(hub).usingDataService({
        dataServiceId: 'redstone-primary-prod',
        uniqueSignersCount: 3,
        dataPackagesIds: ['XMR', 'DAI'],
        authorizedSigners
    });
    
    console.log('Wrapping 5 xDAI...');
    const wrapTx = await wxdai.deposit({ 
        value: ethers.utils.parseEther('5'),
        maxPriorityFeePerGas: ethers.utils.parseUnits('10', 'gwei'),
        maxFeePerGas: ethers.utils.parseUnits('20', 'gwei')
    });
    await wrapTx.wait();
    console.log('  Wrapped!');
    
    const balance = await wxdai.balanceOf(wallet.address);
    console.log('  wxDAI balance:', ethers.utils.formatEther(balance));
    
    console.log('Updating prices...');
    const priceTx = await wrappedHub.updateOraclePrices([], { gasLimit: 500000 });
    await priceTx.wait();
    console.log('  Prices updated!');
    
    console.log('Approving...');
    const approveTx = await wxdai.approve(HUB_ADDRESS, balance, {
        maxPriorityFeePerGas: ethers.utils.parseUnits('10', 'gwei'),
        maxFeePerGas: ethers.utils.parseUnits('20', 'gwei')
    });
    await approveTx.wait();
    
    console.log('Depositing collateral...');
    const depositTx = await hub.depositCollateral(balance, {
        gasLimit: 300000,
        maxPriorityFeePerGas: ethers.utils.parseUnits('10', 'gwei'),
        maxFeePerGas: ethers.utils.parseUnits('20', 'gwei')
    });
    await depositTx.wait();
    console.log('  Deposited! TX:', depositTx.hash);
}

main().catch(console.error);
