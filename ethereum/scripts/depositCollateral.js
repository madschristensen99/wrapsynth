#!/usr/bin/env node
/**
 * One-off helper: top up the LP vault's collateral so mints clear the
 * COLLATERAL_RATIO check. Needed because stuck PENDING mints hold
 * pendingDebt that counts against every new initiateMint.
 *
 * Usage: node scripts/depositCollateral.js [daiAmount]   (default 5)
 */

require('dotenv').config();
const { ethers } = require('ethers');
const { WrapperBuilder } = require('@redstone-finance/evm-connector');
const { getSignersForDataServiceId } = require('@redstone-finance/oracles-smartweave-contracts');
const { HUB_ADDRESS, WXDAI_ADDRESS } = require('./deploymentConfig');

async function retryRedStone(fn, maxRetries = 3) {
    let lastError;
    for (let i = 0; i < maxRetries; i++) {
        try { return await fn(); } catch (err) {
            lastError = err;
            const isTimeout = err.message && (err.message.includes('timeout') || err.message.includes('AggregateError') || err.message.includes('ETIMEDOUT'));
            if (!isTimeout || i === maxRetries - 1) throw err;
            await new Promise(r => setTimeout(r, 2000 * Math.pow(2, i)));
        }
    }
    throw lastError;
}

async function main() {
    if (!process.env.PRIVATE_KEY) { console.error('PRIVATE_KEY not set'); process.exit(1); }
    const amount = ethers.utils.parseEther(process.argv[2] || '5');

    const provider = new ethers.providers.JsonRpcProvider('https://rpc.gnosischain.com');
    const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
    console.log('Wallet:', wallet.address);
    console.log('Depositing', ethers.utils.formatEther(amount), 'xDAI as collateral');

    const hub = new ethers.Contract(HUB_ADDRESS, [
        'function depositCollateral(uint256 amount) external',
        'function updateOraclePrices(bytes[] calldata updateData) external payable',
        'function getVault(address) view returns (tuple(address lpAddress,uint256 collateralShares,uint256 lockedCollateral,uint256 normalizedDebt,uint256 pendingDebt,uint16 maxMintBps,uint256 mintGriefingDeposit,uint16 mintFeeBps,uint16 burnRewardBps,uint256 liquidationNonce,uint256 mintNonce,uint256 minBurnAmount,bool active,uint256 deployedSDAIShares,uint16 maxCoLPRangeBps,uint256 mintTimeoutBlocks,uint256 burnTimeoutBlocks,uint256 pendingMintCount))',
    ], wallet);
    const wxdai = new ethers.Contract(WXDAI_ADDRESS, [
        'function deposit() external payable',
        'function approve(address,uint256) external returns (bool)',
        'function balanceOf(address) view returns (uint256)',
    ], wallet);

    const wrappedHub = WrapperBuilder.wrap(hub).usingDataService({
        dataServiceId: 'redstone-primary-prod',
        uniqueSignersCount: 3,
        dataPackagesIds: ['XMR', 'DAI'],
        authorizedSigners: getSignersForDataServiceId('redstone-primary-prod'),
    });

    // Fresh prices needed for _syncVaultYield inside depositCollateral
    console.log('Updating oracle prices...');
    await (await retryRedStone(() => wrappedHub.updateOraclePrices([], { gasLimit: 500000 }))).wait();
    console.log('Prices updated');

    // Wrap xDAI -> wxDAI
    const wxdaiBal = await wxdai.balanceOf(wallet.address);
    if (wxdaiBal.lt(amount)) {
        const toWrap = amount.sub(wxdaiBal);
        await (await wxdai.deposit({ value: toWrap })).wait();
        console.log('Wrapped', ethers.utils.formatEther(toWrap), 'xDAI');
    }

    await (await wxdai.approve(HUB_ADDRESS, amount)).wait();
    await (await hub.depositCollateral(amount, { gasLimit: 400000 })).wait();
    console.log('Deposited collateral');

    const v = await hub.getVault(wallet.address);
    console.log('Vault collateralShares now:', ethers.utils.formatEther(v.collateralShares));
    console.log('Vault pendingDebt:', v.pendingDebt.toString());
}

main().catch(e => { console.error('Error:', e.message); process.exit(1); });
