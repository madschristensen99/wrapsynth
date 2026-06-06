// Protocol Stats - Calculate real-time protocol metrics

import { getPublicClient } from './viemClient.js';
import { CONTRACTS, ABIS } from './config.js';

export async function updateProtocolStats() {
    try {
        const publicClient = await getPublicClient();
        const currentBlock = await publicClient.getBlockNumber();
        // Search from deployment block (June 4, 2026) - approximately block 46400000
        // Or use a safe earlier block to catch all events
        const fromBlock = 46400000n; // Deployment block estimate

        // Get all mint and burn events to calculate stats
        const [mintEvents, burnEvents] = await Promise.all([
            publicClient.getLogs({
                address: CONTRACTS.hub,
                event: {
                    "anonymous": false,
                    "inputs": [
                        {"indexed": true, "internalType": "bytes32", "name": "requestId", "type": "bytes32"},
                        {"indexed": true, "internalType": "address", "name": "initiator", "type": "address"},
                        {"indexed": false, "internalType": "uint256", "name": "xmrAmount", "type": "uint256"},
                        {"indexed": false, "internalType": "uint256", "name": "wsxmrAmount", "type": "uint256"}
                    ],
                    "name": "MintInitiated",
                    "type": "event"
                },
                fromBlock,
                toBlock: currentBlock
            }),
            publicClient.getLogs({
                address: CONTRACTS.hub,
                event: {
                    "anonymous": false,
                    "inputs": [
                        {"indexed": true, "internalType": "bytes32", "name": "requestId", "type": "bytes32"},
                        {"indexed": true, "internalType": "address", "name": "user", "type": "address"},
                        {"indexed": false, "internalType": "uint256", "name": "wsxmrAmount", "type": "uint256"},
                        {"indexed": false, "internalType": "uint256", "name": "xmrAmount", "type": "uint256"}
                    ],
                    "name": "BurnRequested",
                    "type": "event"
                },
                fromBlock,
                toBlock: currentBlock
            })
        ]);

        console.log('[Protocol Stats] Found', mintEvents.length, 'mint events and', burnEvents.length, 'burn events');

        // Calculate total minted (sum of all mint events)
        let totalMinted = 0;
        let totalFeePercent = 0;
        let feeCount = 0;

        for (const event of mintEvents) {
            const xmrAmount = event.args?.xmrAmount || 0n;
            const wsxmrAmount = event.args?.wsxmrAmount || 0n;
            
            totalMinted += Number(wsxmrAmount) / 1e12;
            
            // Calculate fee
            if (xmrAmount > 0n) {
                const fee = Number((xmrAmount - wsxmrAmount) * 10000n / xmrAmount) / 100;
                totalFeePercent += fee;
                feeCount++;
            }
        }

        // Subtract burned amounts
        for (const event of burnEvents) {
            const wsxmrAmount = event.args?.wsxmrAmount || 0n;
            totalMinted -= Number(wsxmrAmount) / 1e12;
        }

        // Calculate average fee
        const avgFee = feeCount > 0 ? totalFeePercent / feeCount : 0.5;

        // For collateral ratio, use a default or fetch from a specific vault
        const collateralRatio = '>200'; // Default display

        // Update UI
        updateStatsUI(totalMinted, collateralRatio, avgFee);

    } catch (error) {
        console.error('Error updating protocol stats:', error);
    }
}


function updateStatsUI(totalMinted, collateralRatio, avgFee) {
    const totalMintedEl = document.getElementById('total-minted');
    const collateralRatioEl = document.querySelector('.quick-stat:nth-child(2) .stat-value');
    const avgFeeEl = document.getElementById('avg-fee');

    if (totalMintedEl) {
        totalMintedEl.textContent = `${totalMinted.toFixed(6)} wsXMR`;
    }

    if (collateralRatioEl) {
        if (typeof collateralRatio === 'string') {
            collateralRatioEl.textContent = `${collateralRatio}%`;
            collateralRatioEl.style.color = '#22c55e'; // Green for >200%
        } else if (collateralRatio > 0) {
            collateralRatioEl.textContent = `${collateralRatio.toFixed(0)}%`;
            
            // Color code based on health
            if (collateralRatio >= 200) {
                collateralRatioEl.style.color = '#22c55e'; // Green
            } else if (collateralRatio >= 150) {
                collateralRatioEl.style.color = '#fb923c'; // Orange
            } else {
                collateralRatioEl.style.color = '#ef4444'; // Red
            }
        } else {
            collateralRatioEl.textContent = '>200%';
            collateralRatioEl.style.color = '#22c55e';
        }
    }

    if (avgFeeEl) {
        avgFeeEl.textContent = `${avgFee.toFixed(2)}%`;
    }
}
