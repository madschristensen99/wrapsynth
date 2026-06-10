#!/usr/bin/env node
require('dotenv').config();
const { ethers } = require('ethers');
const { WrapperBuilder } = require('@redstone-finance/evm-connector');
const { getSignersForDataServiceId } = require('@redstone-finance/oracles-smartweave-contracts');

const HUB_ADDRESS = '0xd32e2ece901094550b81ab5051a72256761514d6';
const WSXMR_ADDRESS = '0x8890f651190c838651623de077474a98e37803ab';

async function main() {
    if (!process.env.PRIVATE_KEY) {
        console.error('PRIVATE_KEY not set');
        process.exit(1);
    }

    const provider = new ethers.providers.JsonRpcProvider('https://rpc.gnosischain.com');
    const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
    console.log('Wallet:', wallet.address);

    const hubAbi = [
        'function provideLPKey(bytes32 requestId, bytes32 lpPublicSpendKey, bytes32 lpPublicViewKey) external',
        'function setMintReady(bytes32 requestId) external payable',
        'function finalizeMint(bytes32 requestId, bytes32 secret) external',
        'function updateOraclePrices(bytes[] calldata updateData) external payable',
        'function userOpenCoLP(address lpVault, uint256 wsxmrAmount, uint256 deadline) external returns (uint256 tokenId)',
        'function getPendingReturns(address user, address token) external view returns (uint256)',
        'function withdrawReturns(address token) external',
        'event CoLPDeployed(address indexed lpVault, address indexed user, uint256 indexed tokenId, uint256 sDAIShares, uint256 wsxmrAmount, uint16 rangeBps)'
    ];

    const wsxmrAbi = [
        'function balanceOf(address) external view returns (uint256)',
        'function approve(address spender, uint256 amount) external returns (bool)',
        'function decimals() external view returns (uint8)'
    ];

    const hub = new ethers.Contract(HUB_ADDRESS, hubAbi, wallet);
    const wsxmr = new ethers.Contract(WSXMR_ADDRESS, wsxmrAbi, wallet);

    const authorizedSigners = getSignersForDataServiceId('redstone-primary-prod');
    const wrappedHub = WrapperBuilder.wrap(hub).usingDataService({
        dataServiceId: 'redstone-primary-prod',
        uniqueSignersCount: 3,
        dataPackagesIds: ['XMR', 'DAI'],
        authorizedSigners
    });

    // These are from the previous run
    const requestId = '0x488486cfd5e8fb8e8b5f6a8534fb58d6725e96206b220dff318ee0784e223960';
    const lpPublicKey = '0xd899f359d45d748611f42ed319c27241ea1bc41fb5a213e7cfb06be2c0c97e20';
    const secret = '0x' + Buffer.from([185, 163, 13, 31, 170, 83, 76, 141, 6, 158, 53, 188, 173, 233, 27, 152, 100, 200, 113, 53, 253, 32, 187, 206, 29, 212, 174, 156, 57, 68, 81, 170]).toString('hex');
    const griefingDeposit = ethers.utils.parseEther('0.001');

    console.log('Replacing stuck provideLPKey tx with higher gas...');
    const bumpTx = await hub.provideLPKey(requestId, lpPublicKey, lpPublicKey, {
        nonce: 3593,
        maxPriorityFeePerGas: ethers.utils.parseUnits('10', 'gwei'),
        maxFeePerGas: ethers.utils.parseUnits('20', 'gwei'),
        gasLimit: 200000
    });
    await bumpTx.wait();
    console.log('  LP key provided:', bumpTx.hash);

    console.log('Setting mint ready...');
    const readyTx = await hub.setMintReady(requestId, {
        value: griefingDeposit,
        gasLimit: 200000,
        maxPriorityFeePerGas: ethers.utils.parseUnits('10', 'gwei'),
        maxFeePerGas: ethers.utils.parseUnits('20', 'gwei')
    });
    await readyTx.wait();
    console.log('  Mint ready:', readyTx.hash);

    console.log('Finalizing mint...');
    const finalizeTx = await hub.finalizeMint(requestId, secret, {
        gasLimit: 1000000,
        maxPriorityFeePerGas: ethers.utils.parseUnits('10', 'gwei'),
        maxFeePerGas: ethers.utils.parseUnits('20', 'gwei')
    });
    await finalizeTx.wait();
    console.log('  Mint finalized:', finalizeTx.hash);

    const wsxmrBalance = await wsxmr.balanceOf(wallet.address);
    console.log('  wsXMR balance after mint:', ethers.utils.formatUnits(wsxmrBalance, 8));

    // Step 3: Co-LP half
    const wsxmrToDeposit = wsxmrBalance.div(2);
    console.log('Co-LPing', ethers.utils.formatUnits(wsxmrToDeposit, 8), 'wsXMR...');

    if (wsxmrToDeposit.eq(0)) {
        console.error('ERROR: wsxmrToDeposit is 0');
        process.exit(1);
    }

    const approveTx = await wsxmr.approve(HUB_ADDRESS, wsxmrToDeposit, {
        maxPriorityFeePerGas: ethers.utils.parseUnits('10', 'gwei'),
        maxFeePerGas: ethers.utils.parseUnits('20', 'gwei')
    });
    await approveTx.wait();

    const preCoLPTx = await wrappedHub.updateOraclePrices([], { gasLimit: 500000 });
    await preCoLPTx.wait();
    console.log('  Prices pushed');

    const deadline = Math.floor(Date.now() / 1000) + 3600;
    const coLPTx = await hub.userOpenCoLP(wallet.address, wsxmrToDeposit, deadline, {
        gasLimit: 2000000,
        maxPriorityFeePerGas: ethers.utils.parseUnits('10', 'gwei'),
        maxFeePerGas: ethers.utils.parseUnits('20', 'gwei')
    });
    const coLPReceipt = await coLPTx.wait();
    console.log('  Co-LP TX:', coLPTx.hash);

    let tokenId = null;
    if (coLPReceipt.events) {
        const evt = coLPReceipt.events.find(e => e.event === 'CoLPDeployed');
        if (evt) tokenId = evt.args.tokenId;
    }
    if (!tokenId) {
        for (const log of coLPReceipt.logs) {
            try {
                const parsed = hub.interface.parseLog(log);
                if (parsed.name === 'CoLPDeployed') {
                    tokenId = parsed.args.tokenId;
                    break;
                }
            } catch (e) {}
        }
    }

    console.log('  Token ID:', tokenId ? ethers.BigNumber.from(tokenId).toString() : 'unknown');
    console.log('  View on Gnosisscan: https://gnosisscan.io/tx/' + coLPTx.hash);

    const finalBalance = await wsxmr.balanceOf(wallet.address);
    console.log('  Final wsXMR balance:', ethers.utils.formatUnits(finalBalance, 8));
    console.log('Done!');
}

main().catch(console.error);
