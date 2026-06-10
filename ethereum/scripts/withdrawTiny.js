#!/usr/bin/env node
require('dotenv').config();
const { ethers } = require('ethers');
const { WrapperBuilder } = require('@redstone-finance/evm-connector');
const { getSignersForDataServiceId } = require('@redstone-finance/oracles-smartweave-contracts');
const { HUB_ADDRESS, SDAI_ADDRESS } = require('./deploymentConfig');

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
    'function convertToAssets(uint256 shares) external view returns (uint256)'
];

async function main() {
    const provider = new ethers.providers.JsonRpcProvider('https://rpc.gnosischain.com');
    const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
    
    const hub = new ethers.Contract(HUB_ADDRESS, HUB_ABI, wallet);
    const sdai = new ethers.Contract(SDAI_ADDRESS, SDAI_ABI, provider);
    
    console.log('Updating prices...');
    const authorizedSigners = getSignersForDataServiceId("redstone-primary-prod");
    const wrappedHub = WrapperBuilder.wrap(hub).usingDataService({
        dataServiceId: "redstone-primary-prod",
        uniqueSignersCount: 3,
        dataPackagesIds: ["XMR", "DAI"],
        authorizedSigners
    });
    
    const updateTx = await wrappedHub.updateOraclePrices([]);
    await updateTx.wait();
    console.log('Prices updated');
    
    // Try withdrawing just 0.1 sDAI worth of shares
    const targetAssets = ethers.utils.parseEther('0.2');
    const vault = await hub.getVault(wallet.address);
    const totalAssets = await sdai.convertToAssets(vault.collateralShares);
    const sharesToWithdraw = targetAssets.mul(vault.collateralShares).div(totalAssets);
    
    console.log('Attempting to withdraw', ethers.utils.formatEther(targetAssets), 'sDAI');
    console.log('Shares:', sharesToWithdraw.toString());
    
    const tx = await hub.withdrawCollateral(sharesToWithdraw, { gasLimit: 1000000 });
    console.log('TX:', tx.hash);
    await tx.wait();
    console.log('✅ Success!');
}

main().catch(console.error);
