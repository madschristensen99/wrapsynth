// Dashboard - Global stats and vault health monitoring

import { CONTRACTS, ABIS, DECIMALS } from './config.js';
import { readHub, readWsxmr, getUserAddress } from './viemClient.js';
import { formatUnits } from 'https://esm.sh/viem@2.7.0';

export class Dashboard {
    constructor() {
        this.userAddress = null;
        this.globalStats = null;
        this.vaults = [];
        this.userPositions = {
            mints: [],
            burns: []
        };
    }

    async init() {
        this.userAddress = getUserAddress();
        await this.loadGlobalStats();
        await this.loadVaults();
        
        if (this.userAddress) {
            await this.loadUserPositions();
        }
    }

    async loadGlobalStats() {
        try {
            const totalSupply = await readWsxmr('totalSupply', []);
            const xmrPrice = await readHub('getXmrPrice', []);
            const collateralPrice = await readHub('getCollateralPrice', []);
            const vaultCount = await readHub('getVaultCount', []);

            this.globalStats = {
                totalSupply: formatUnits(totalSupply, DECIMALS.wsXMR),
                xmrPrice: formatUnits(xmrPrice, DECIMALS.USD),
                collateralPrice: formatUnits(collateralPrice, DECIMALS.USD),
                vaultCount: Number(vaultCount),
                tvl: 0
            };

            return this.globalStats;
        } catch (error) {
            console.error('Error loading global stats:', error);
            return null;
        }
    }

    async loadVaults() {
        try {
            const vaultCount = await readHub('getVaultCount', []);
            const vaults = [];

            for (let i = 0; i < Number(vaultCount); i++) {
                const lpAddress = await readHub('getVaultAtIndex', [BigInt(i)]);
                const vault = await readHub('getVault', [lpAddress]);
                const health = await readHub('getVaultHealth', [lpAddress]);
                const debt = await readHub('getVaultDebt', [lpAddress]);

                vaults.push({
                    lpAddress,
                    collateralShares: formatUnits(vault.collateralShares, DECIMALS.ETH),
                    lockedCollateral: formatUnits(vault.lockedCollateral, DECIMALS.ETH),
                    debt: formatUnits(debt, DECIMALS.wsXMR),
                    health: formatUnits(health, 16),
                    mintFeeBps: vault.mintFeeBps,
                    burnRewardBps: vault.burnRewardBps,
                    active: vault.active
                });
            }

            this.vaults = vaults;
            return vaults;
        } catch (error) {
            console.error('Error loading vaults:', error);
            return [];
        }
    }

    async loadUserPositions() {
        if (!this.userAddress) return;

        try {
            const mintRequestIds = await readHub('getUserMintRequests', [this.userAddress]);
            const burnRequestIds = await readHub('getUserBurnRequests', [this.userAddress]);

            const mints = [];
            for (const requestId of mintRequestIds) {
                try {
                    const request = await readHub('getMintRequest', [requestId]);
                    mints.push({
                        requestId,
                        lpVault: request.lpVault,
                        xmrAmount: formatUnits(request.xmrAmount, DECIMALS.XMR),
                        wsxmrAmount: formatUnits(request.wsxmrAmount, DECIMALS.wsXMR),
                        status: request.status,
                        timeout: new Date(Number(request.timeout) * 1000)
                    });
                } catch (error) {
                    console.warn('Error loading mint request:', requestId, error);
                }
            }

            const burns = [];
            for (const requestId of burnRequestIds) {
                try {
                    const request = await readHub('getBurnRequest', [requestId]);
                    burns.push({
                        requestId,
                        lpVault: request.lpVault,
                        wsxmrAmount: formatUnits(request.wsxmrAmount, DECIMALS.wsXMR),
                        xmrAmount: formatUnits(request.xmrAmount, DECIMALS.XMR),
                        status: request.status,
                        deadline: new Date(Number(request.deadline) * 1000)
                    });
                } catch (error) {
                    console.warn('Error loading burn request:', requestId, error);
                }
            }

            this.userPositions = { mints, burns };
            return this.userPositions;
        } catch (error) {
            console.error('Error loading user positions:', error);
            return { mints: [], burns: [] };
        }
    }

    async refreshPrices() {
        try {
            const xmrPrice = await readHub('getXmrPrice', []);
            const collateralPrice = await readHub('getCollateralPrice', []);

            if (this.globalStats) {
                this.globalStats.xmrPrice = formatUnits(xmrPrice, DECIMALS.USD);
                this.globalStats.collateralPrice = formatUnits(collateralPrice, DECIMALS.USD);
            }

            return {
                xmrPrice: formatUnits(xmrPrice, DECIMALS.USD),
                collateralPrice: formatUnits(collateralPrice, DECIMALS.USD)
            };
        } catch (error) {
            console.error('Error refreshing prices:', error);
            return null;
        }
    }

    getHealthColor(healthRatio) {
        const health = parseFloat(healthRatio);
        if (health >= 200) return 'green';
        if (health >= 150) return 'yellow';
        if (health >= 120) return 'orange';
        return 'red';
    }

    getStatusText(statusCode) {
        const statuses = {
            0: 'Pending',
            1: 'Ready',
            2: 'Finalized',
            3: 'Cancelled',
            4: 'Committed',
            5: 'Slashed'
        };
        return statuses[statusCode] || 'Unknown';
    }
}

let dashboardInstance = null;

export function getDashboard() {
    if (!dashboardInstance) {
        dashboardInstance = new Dashboard();
    }
    return dashboardInstance;
}
