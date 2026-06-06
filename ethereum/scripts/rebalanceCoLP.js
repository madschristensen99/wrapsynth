#!/usr/bin/env node
/**
 * Rebalance out-of-range Co-LP position to current price
 */

require('dotenv').config();
const { ethers } = require('ethers');
const { WrapperBuilder } = require('@redstone-finance/evm-connector');
const { getSignersForDataServiceId } = require('@redstone-finance/oracles-smartweave-contracts');

const HUB_ADDRESS = '0xd32e2ece901094550b81ab5051a72256761514d6';
const TOKEN_ID = 5477;

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
        'function rebalanceCoLP(uint256 tokenId, uint16 newRangeBps, uint256 deadline) external',
        'function updateOraclePrices(bytes[] calldata updateData) external payable',
        'function getPendingReturns(address user, address token) external view returns (uint256)',
        'function withdrawReturns(address token) external',
        'event CoLPRebalanced(uint256 indexed oldTokenId, uint256 indexed newTokenId, address indexed vault, address user, address keeper, uint16 newRangeBps)'
    ];

    const hub = new ethers.Contract(HUB_ADDRESS, hubAbi, wallet);

    const authorizedSigners = getSignersForDataServiceId('redstone-primary-prod');
    const wrappedHub = WrapperBuilder.wrap(hub).usingDataService({
        dataServiceId: 'redstone-primary-prod',
        uniqueSignersCount: 3,
        dataPackagesIds: ['XMR', 'DAI'],
        authorizedSigners
    });

    // Push fresh prices first
    console.log('Pushing fresh oracle prices...');
    const priceTx = await wrappedHub.updateOraclePrices([], { gasLimit: 500000 });
    await priceTx.wait();
    console.log('  Prices updated:', priceTx.hash);
    console.log('');

    // Rebalance the position
    console.log('Rebalancing Co-LP position', TOKEN_ID, '...');
    const deadline = Math.floor(Date.now() / 1000) + 3600;
    const newRangeBps = 500; // 5% range

    const rebalanceTx = await hub.rebalanceCoLP(TOKEN_ID, newRangeBps, deadline, {
        gasLimit: 3000000,
        maxPriorityFeePerGas: ethers.utils.parseUnits('10', 'gwei'),
        maxFeePerGas: ethers.utils.parseUnits('20', 'gwei')
    });
    const receipt = await rebalanceTx.wait();
    console.log('  Rebalance TX:', rebalanceTx.hash);

    // Parse new token ID from event
    let newTokenId = null;
    if (receipt.events) {
        const evt = receipt.events.find(e => e.event === 'CoLPRebalanced');
        if (evt) newTokenId = evt.args.newTokenId;
    }
    if (!newTokenId) {
        for (const log of receipt.logs) {
            try {
                const parsed = hub.interface.parseLog(log);
                if (parsed.name === 'CoLPRebalanced') {
                    newTokenId = parsed.args.newTokenId;
                    break;
                }
            } catch (e) {}
        }
    }

    console.log('  New Token ID:', newTokenId ? ethers.BigNumber.from(newTokenId).toString() : 'unknown');
    console.log('  View on Gnosisscan: https://gnosisscan.io/tx/' + rebalanceTx.hash);
    console.log('');

    // Check pending returns (keeper fee or leftover)
    const WSXMR_ADDRESS = '0x8890f651190c838651623de077474a98e37803ab';
    const pendingWsxmr = await hub.getPendingReturns(wallet.address, WSXMR_ADDRESS);
    if (pendingWsxmr.gt(0)) {
        console.log('Withdrawing pending wsXMR returns...');
        const withdrawTx = await hub.withdrawReturns(WSXMR_ADDRESS, {
            gasLimit: 200000,
            maxPriorityFeePerGas: ethers.utils.parseUnits('10', 'gwei'),
            maxFeePerGas: ethers.utils.parseUnits('20', 'gwei')
        });
        await withdrawTx.wait();
        console.log('  Withdrawn:', ethers.utils.formatUnits(pendingWsxmr, 8), 'wsXMR');
    }

    console.log('Done! Position rebalanced.');
}

main().catch(console.error);
