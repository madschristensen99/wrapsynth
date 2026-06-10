require('dotenv').config();
const { ethers } = require('ethers');
const { WrapperBuilder } = require('@redstone-finance/evm-connector');
const { getSignersForDataServiceId } = require('@redstone-finance/oracles-smartweave-contracts');

const deployment = require('./deploymentConfig');

const VAULT_ABI_FIELDS = [
    'address lpAddress',
    'uint256 collateralShares',
    'uint256 lockedCollateral',
    'uint256 normalizedDebt',
    'uint256 pendingDebt',
    'uint16 maxMintBps',
    'uint256 mintGriefingDeposit',
    'uint256 mintReadyBond',
    'uint16 mintFeeBps',
    'uint16 burnRewardBps',
    'uint256 liquidationNonce',
    'uint256 mintNonce',
    'uint256 minBurnAmount',
    'bool active',
    'uint256 deployedSDAIShares',
    'uint16 maxCoLPRangeBps',
    'uint256 mintTimeoutBlocks',
    'uint256 burnTimeoutBlocks'
].join(', ');

const HUB_ABI = [
    `function getVault(address lpAddress) external view returns (tuple(${VAULT_ABI_FIELDS}))`,
    'function withdrawCollateral(uint256 amount) external',
    'function getXmrPrice() external view returns (uint256)',
    'function getCollateralPrice() external view returns (uint256)',
    'function updateOraclePrices(bytes[] calldata) external payable',
    'function hasActiveVault(address lpAddress) external view returns (bool)'
];

const SDAI_ABI = [
    'function convertToAssets(uint256 shares) external view returns (uint256)',
    'function balanceOf(address) external view returns (uint256)',
    'function decimals() external view returns (uint8)'
];

async function main() {
    if (!process.env.PRIVATE_KEY) {
        console.error('❌ PRIVATE_KEY not set');
        process.exit(1);
    }

    const provider = new ethers.providers.JsonRpcProvider('https://rpc.gnosischain.com');
    const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);

    console.log('💰 Update Prices & Safe Withdraw');
    console.log('Wallet:', wallet.address);
    console.log('Hub:', deployment.HUB_ADDRESS);
    console.log('');

    const hub = new ethers.Contract(deployment.HUB_ADDRESS, HUB_ABI, wallet);
    const sdai = new ethers.Contract(deployment.SDAI_ADDRESS, SDAI_ABI, provider);

    // Step 1: Update prices
    console.log('Step 1: Updating oracle prices...');
    const authorizedSigners = getSignersForDataServiceId("redstone-primary-prod");
    const wrappedHub = WrapperBuilder.wrap(hub).usingDataService({
        dataServiceId: "redstone-primary-prod",
        uniqueSignersCount: 3,
        dataPackagesIds: ["XMR", "DAI"],
        authorizedSigners
    });
    
    const updateTx = await wrappedHub.updateOraclePrices([]);
    console.log('Price update TX:', updateTx.hash);
    await updateTx.wait();
    console.log('✅ Prices updated');
    console.log('');

    // Step 2: Get vault state
    const hasVault = await hub.hasActiveVault(wallet.address);
    if (!hasVault) {
        console.log('❌ No active vault');
        return;
    }

    const vault = await hub.getVault(wallet.address);
    console.log('Vault State:');
    console.log('  Collateral Shares:', vault.collateralShares.toString());
    console.log('  Locked Collateral:', vault.lockedCollateral.toString());
    console.log('  Normalized Debt:', vault.normalizedDebt.toString());
    console.log('  Pending Debt:', vault.pendingDebt.toString());
    console.log('  Deployed sDAI:', vault.deployedSDAIShares.toString());
    console.log('');

    // Step 3: Get live prices
    const xmrPrice = await hub.getXmrPrice();
    const collateralPrice = await hub.getCollateralPrice();
    console.log('Live Prices:');
    console.log('  XMR:', ethers.utils.formatUnits(xmrPrice, 18), 'USD');
    console.log('  Collateral:', ethers.utils.formatUnits(collateralPrice, 18), 'USD');
    console.log('');

    // Step 4: Calculate safe withdraw amount
    const collateralAssets = await sdai.convertToAssets(vault.collateralShares);
    const collateralValueUsd = collateralAssets.mul(collateralPrice).div(ethers.utils.parseEther('1'));
    const debtValueUsd = vault.normalizedDebt.mul(xmrPrice).div(1e8);
    const requiredCollateralUsd = debtValueUsd.mul(150).div(100);
    const withdrawableUsd = collateralValueUsd.gt(requiredCollateralUsd)
        ? collateralValueUsd.sub(requiredCollateralUsd)
        : ethers.BigNumber.from(0);

    console.log('Financial Summary:');
    console.log('  Collateral Value:', ethers.utils.formatEther(collateralValueUsd), 'USD');
    console.log('  Debt Value:', ethers.utils.formatEther(debtValueUsd), 'USD');
    console.log('  Required (150%):', ethers.utils.formatEther(requiredCollateralUsd), 'USD');
    console.log('  Withdrawable:', ethers.utils.formatEther(withdrawableUsd), 'USD');
    console.log('');

    if (withdrawableUsd.lte(0)) {
        console.log('❌ Nothing to withdraw');
        return;
    }

    const withdrawableAssets = withdrawableUsd.mul(ethers.utils.parseEther('1')).div(collateralPrice);
    const withdrawableShares = collateralAssets.gt(0)
        ? withdrawableAssets.mul(vault.collateralShares).div(collateralAssets)
        : ethers.BigNumber.from(0);
    const safeWithdrawShares = withdrawableShares.mul(95).div(100);

    const withdrawAssets = await sdai.convertToAssets(safeWithdrawShares);
    console.log('Withdrawing:');
    console.log('  Shares:', safeWithdrawShares.toString());
    console.log('  Assets:', ethers.utils.formatEther(withdrawAssets), 'sDAI');
    console.log('');

    // Step 5: Withdraw immediately while prices are fresh
    console.log('Step 2: Withdrawing...');
    const withdrawTx = await hub.withdrawCollateral(safeWithdrawShares, { gasLimit: 500000 });
    console.log('Withdraw TX:', withdrawTx.hash);
    await withdrawTx.wait();
    console.log('✅ Withdrawal complete!');

    const vaultAfter = await hub.getVault(wallet.address);
    console.log('');
    console.log('Vault After:');
    console.log('  Collateral Shares:', vaultAfter.collateralShares.toString());
    console.log('  sDAI balance:', ethers.utils.formatEther(await sdai.balanceOf(wallet.address)), 'sDAI');
}

main().catch(err => {
    console.error('Fatal error:', err.message || err);
    process.exit(1);
});
