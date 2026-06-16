// LP Operator Panel - Vault management for liquidity providers

import { CONTRACTS, ABIS, DECIMALS } from './config.js';
import { readHub, writeHub, getUserAddress } from './viemClient.js';
import { formatUnits, parseUnits } from 'https://esm.sh/viem@2.7.0';

export class LPPanel {
    constructor() {
        this.userAddress = null;
        this.vault = null;
        this.isLP = false;
    }

    async init() {
        this.userAddress = getUserAddress();
        if (!this.userAddress) {
            throw new Error('Wallet not connected');
        }

        this.isLP = await readHub('hasActiveVault', [this.userAddress]);
        
        if (this.isLP) {
            await this.loadVaultData();
        }

        return this.isLP;
    }

    async loadVaultData() {
        this.vault = await readHub('getVault', [this.userAddress]);
        
        const health = await readHub('getVaultHealth', [this.userAddress]);
        const debt = await readHub('getVaultDebt', [this.userAddress]);
        
        return {
            vault: this.vault,
            health,
            debt
        };
    }

    async createVault() {
        const receipt = await writeHub('createVault', []);
        console.log('Vault created:', receipt.transactionHash);
        
        await this.init();
        return receipt;
    }

    async depositCollateral(amountXDAI) {
        const amount = parseUnits(amountXDAI.toString(), DECIMALS.ETH);
        const receipt = await writeHub('depositCollateral', [amount]);
        console.log('Collateral deposited:', receipt.transactionHash);
        
        await this.loadVaultData();
        return receipt;
    }

    async withdrawCollateral(shares) {
        const receipt = await writeHub('withdrawCollateral', [shares]);
        console.log('Collateral withdrawn:', receipt.transactionHash);
        
        await this.loadVaultData();
        return receipt;
    }

    async setMintFee(feeBps) {
        const currentVault = await readHub('getVault', [this.userAddress]);
        const receipt = await writeHub('setVaultMarketMetrics', [
            feeBps,
            currentVault.burnRewardBps
        ]);
        console.log('Mint fee updated:', receipt.transactionHash);
        
        await this.loadVaultData();
        return receipt;
    }

    async setBurnReward(rewardBps) {
        const currentVault = await readHub('getVault', [this.userAddress]);
        const receipt = await writeHub('setVaultMarketMetrics', [
            currentVault.mintFeeBps,
            rewardBps
        ]);
        console.log('Burn reward updated:', receipt.transactionHash);
        
        await this.loadVaultData();
        return receipt;
    }

    async setGriefingDeposit(depositXDAI) {
        const deposit = parseUnits(depositXDAI.toString(), DECIMALS.ETH);
        const receipt = await writeHub('setMintGriefingDeposit', [deposit]);
        console.log('Griefing deposit updated:', receipt.transactionHash);
        
        await this.loadVaultData();
        return receipt;
    }

    async setMaxMintBps(maxBps) {
        const receipt = await writeHub('setMaxMintBps', [maxBps]);
        console.log('Max mint BPS updated:', receipt.transactionHash);
        
        await this.loadVaultData();
        return receipt;
    }

    async getPendingMints() {
        return await readHub('getVaultPendingMints', [this.userAddress]);
    }

    async getPendingReturns(tokenAddress) {
        return await readHub('getPendingReturns', [this.userAddress, tokenAddress]);
    }

    async withdrawReturns(tokenAddress) {
        const receipt = await writeHub('withdrawReturns', [tokenAddress]);
        console.log('Returns withdrawn:', receipt.transactionHash);
        return receipt;
    }

    async deactivateVault() {
        const receipt = await writeHub('deactivateVault', []);
        console.log('Vault deactivated:', receipt.transactionHash);
        
        await this.init();
        return receipt;
    }

    formatVaultData() {
        if (!this.vault) return null;

        return {
            collateralShares: formatUnits(this.vault.collateralShares, DECIMALS.ETH),
            lockedCollateral: formatUnits(this.vault.lockedCollateral, DECIMALS.ETH),
            normalizedDebt: formatUnits(this.vault.normalizedDebt, DECIMALS.wsXMR),
            pendingDebt: formatUnits(this.vault.pendingDebt, DECIMALS.wsXMR),
            maxMintBps: this.vault.maxMintBps,
            mintGriefingDeposit: formatUnits(this.vault.mintGriefingDeposit, DECIMALS.ETH),
            mintReadyBond: formatUnits(this.vault.mintReadyBond, DECIMALS.ETH),
            mintFeeBps: this.vault.mintFeeBps,
            burnRewardBps: this.vault.burnRewardBps,
            minBurnAmount: formatUnits(this.vault.minBurnAmount, DECIMALS.wsXMR),
            active: this.vault.active
        };
    }
}

let lpPanelInstance = null;

export function getLPPanel() {
    if (!lpPanelInstance) {
        lpPanelInstance = new LPPanel();
    }
    return lpPanelInstance;
}
