#!/usr/bin/env node
/**
 * Unwind the old out-of-range Co-LP position and open a new one at current price
 */

require('dotenv').config();
const { ethers } = require('ethers');
const { WrapperBuilder } = require('@redstone-finance/evm-connector');
const { getSignersForDataServiceId } = require('@redstone-finance/oracles-smartweave-contracts');

const HUB_ADDRESS = '0xd32e2ece901094550b81ab5051a72256761514d6';
const WSXMR_ADDRESS = '0x8890f651190c838651623de077474a98e37803ab';
const TOKEN_ID_TO_UNWIND = 5476;

async function main() {
    if (!process.env.PRIVATE_KEY) {
        console.error('PRIVATE_KEY not set');
        process.exit(1);
    }

    const provider = new ethers.providers.JsonRpcProvider('https://rpc.gnosischain.com');
    const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
    console.log('Wallet:', wallet.address);
    console.log('');

    const hubAbi = [
        'function unwindCoLP(uint256 tokenId, uint256 deadline) external',
        'function userOpenCoLP(address lpVault, uint256 wsxmrAmount, uint256 deadline) external returns (uint256 tokenId)',
        'function updateOraclePrices(bytes[] calldata updateData) external payable',
        'function getPendingReturns(address user, address token) external view returns (uint256)',
        'function withdrawReturns(address token) external',
        'event CoLPDeployed(address indexed lpVault, address indexed user, uint256 indexed tokenId, uint256 sDAIShares, uint256 wsxmrAmount, uint16 rangeBps)',
        'event CoLPUnwound(uint256 indexed tokenId, address indexed vaultOwner, address indexed user, uint256 sDAIReturned, uint256 wsxmrReturned)'
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

    // Step 1: Unwind old position
    console.log('Step 1: Unwind old Co-LP position', TOKEN_ID_TO_UNWIND);
    const deadline = Math.floor(Date.now() / 1000) + 3600;
    const unwindTx = await hub.unwindCoLP(TOKEN_ID_TO_UNWIND, deadline, {
        gasLimit: 2000000,
        maxPriorityFeePerGas: ethers.utils.parseUnits('10', 'gwei'),
        maxFeePerGas: ethers.utils.parseUnits('20', 'gwei')
    });
    const unwindReceipt = await unwindTx.wait();
    console.log('  Unwind TX:', unwindTx.hash);

    // Check pending returns
    const pendingWsxmr = await hub.getPendingReturns(wallet.address, WSXMR_ADDRESS);
    console.log('  Pending wsXMR returns:', ethers.utils.formatUnits(pendingWsxmr, 8));

    if (pendingWsxmr.gt(0)) {
        const withdrawTx = await hub.withdrawReturns(WSXMR_ADDRESS, {
            gasLimit: 200000,
            maxPriorityFeePerGas: ethers.utils.parseUnits('10', 'gwei'),
            maxFeePerGas: ethers.utils.parseUnits('20', 'gwei')
        });
        await withdrawTx.wait();
        console.log('  Withdrawn wsXMR:', withdrawTx.hash);
    }

    const wsxmrBalance = await wsxmr.balanceOf(wallet.address);
    console.log('  wsXMR balance after unwind:', ethers.utils.formatUnits(wsxmrBalance, 8));
    console.log('');

    // Step 2: Push fresh prices
    console.log('Step 2: Push fresh oracle prices');
    const priceTx = await wrappedHub.updateOraclePrices([], { gasLimit: 500000 });
    await priceTx.wait();
    console.log('  Prices updated:', priceTx.hash);
    console.log('');

    // Step 3: Open new Co-LP with half of wsXMR
    console.log('Step 3: Open new Co-LP position');
    const wsxmrToDeposit = wsxmrBalance.div(2);
    console.log('  Depositing', ethers.utils.formatUnits(wsxmrToDeposit, 8), 'wsXMR');

    if (wsxmrToDeposit.eq(0)) {
        console.error('ERROR: Not enough wsXMR');
        process.exit(1);
    }

    const approveTx = await wsxmr.approve(HUB_ADDRESS, wsxmrToDeposit, {
        maxPriorityFeePerGas: ethers.utils.parseUnits('10', 'gwei'),
        maxFeePerGas: ethers.utils.parseUnits('20', 'gwei')
    });
    await approveTx.wait();
    console.log('  Approved');

    const preCoLPTx = await wrappedHub.updateOraclePrices([], { gasLimit: 500000 });
    await preCoLPTx.wait();
    console.log('  Prices pushed');

    const newDeadline = Math.floor(Date.now() / 1000) + 3600;
    const coLPTx = await hub.userOpenCoLP(wallet.address, wsxmrToDeposit, newDeadline, {
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

    console.log('  New Token ID:', tokenId ? ethers.BigNumber.from(tokenId).toString() : 'unknown');
    console.log('  View on Gnosisscan: https://gnosisscan.io/tx/' + coLPTx.hash);

    const finalBalance = await wsxmr.balanceOf(wallet.address);
    console.log('  Final wsXMR balance:', ethers.utils.formatUnits(finalBalance, 8));
    console.log('');

    console.log('Done! Old position unwound, new position opened.');
}

main().catch(console.error);
