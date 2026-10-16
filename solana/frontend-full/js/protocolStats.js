// Protocol Stats - Calculate real-time protocol metrics

import { getPublicClient, getContractEventsChunked, readHub } from './viemClient.js?v=3.22';
import { CONTRACTS } from './config.js?v=3.22';
import { formatUnits } from 'https://esm.sh/viem@2.7.0';

// Correct inline event definitions matching the deployed contract ABI
const MINT_INITIATED_EVENT = {
    anonymous: false,
    inputs: [
        { indexed: true, internalType: 'bytes32', name: 'requestId', type: 'bytes32' },
        { indexed: true, internalType: 'address', name: 'initiator', type: 'address' },
        { indexed: true, internalType: 'address', name: 'recipient', type: 'address' },
        { indexed: false, internalType: 'address', name: 'lpVault', type: 'address' },
        { indexed: false, internalType: 'uint256', name: 'xmrAmount', type: 'uint256' },
        { indexed: false, internalType: 'uint256', name: 'wsxmrAmount', type: 'uint256' },
        { indexed: false, internalType: 'uint256', name: 'feeAmount', type: 'uint256' },
        { indexed: false, internalType: 'bytes32', name: 'claimCommitment', type: 'bytes32' },
        { indexed: false, internalType: 'bytes32', name: 'userPublicKey', type: 'bytes32' },
        { indexed: false, internalType: 'uint256', name: 'timeout', type: 'uint256' }
    ],
    name: 'MintInitiated',
    type: 'event'
};

const DEPLOYMENT_BLOCK = 46200000n; // HyperEVM hub deployment block
const MAX_BLOCK_RANGE = 10000n; // Conservative limit to avoid RPC errors

export async function updateProtocolStats() {
    try {
        const publicClient = getPublicClient();
        const currentBlock = await publicClient.getBlockNumber();
        const fromBlock = currentBlock - MAX_BLOCK_RANGE > DEPLOYMENT_BLOCK
            ? currentBlock - MAX_BLOCK_RANGE
            : DEPLOYMENT_BLOCK;

        // Fetch mint events (chunked — HyperEVM RPCs cap eth_getLogs at ~1000 blocks)
        const mintEvents = await getContractEventsChunked({
            address: CONTRACTS.hub,
            abi: [MINT_INITIATED_EVENT],
            eventName: 'MintInitiated',
            fromBlock,
            toBlock: 'latest'
        }).catch(err => {
            console.warn('[Protocol Stats] Mint events fetch failed:', err);
            return [];
        });

        // Total Minted Ever: sum of all wsxmrAmount from mints (do NOT subtract burns)
        let totalMinted = 0;
        for (const event of mintEvents) {
            const wsxmrAmount = event.args?.wsxmrAmount || 0n;
            totalMinted += Number(wsxmrAmount) / 1e8;
        }

        // Fetch all vault data in one pass: collateral, debt, and fee settings
        const {
            collateralRatio,
            avgMintFee,
            avgBurnReward
        } = await fetchVaultAggregates();

        updateStatsUI(totalMinted, collateralRatio, avgMintFee, avgBurnReward);
    } catch (error) {
        console.error('Error updating protocol stats:', error);
    }
}

async function fetchVaultAggregates() {
    // Gather vault addresses
    const vaultAddresses = [];
    try {
        const vaultCount = await readHub('getVaultCount');
        // Fetch all vault addresses in parallel
        const addrResults = await Promise.all(
            Array.from({ length: Number(vaultCount) }, (_, i) =>
                readHub('vaultList', [BigInt(i)]).catch(() => null)
            )
        );
        for (const addr of addrResults) {
            if (addr) vaultAddresses.push(addr);
        }
    } catch (e) {
        console.warn('[Protocol Stats] getVaultCount failed, using fallback');
    }

    if (vaultAddresses.length === 0 && CONTRACTS.defaultLpVault) {
        vaultAddresses.push(CONTRACTS.defaultLpVault);
    }

    // Fetch oracle prices — use the public storage getters (never revert) so the
    // last logged price is always available even when the oracle is stale.
    let xmrPrice = 0;
    let collateralPrice = 1.0;
    try {
        const [xmrPriceRaw, collPriceRaw] = await Promise.all([
            readHub('lastXmrPrice').catch(() => null),
            readHub('lastCollateralPrice').catch(() => null),
        ]);
        if (xmrPriceRaw !== null) xmrPrice = Number(xmrPriceRaw) / 1e8;
        if (collPriceRaw !== null) collateralPrice = Number(collPriceRaw) / 1e8;
    } catch (e) {
        console.warn('[Protocol Stats] Price fetch failed, using defaults');
    }
    if (xmrPrice <= 0) xmrPrice = 150; // last resort — should not happen

    // Fetch all vault data + debts in parallel
    const vaultResults = await Promise.all(
        vaultAddresses.map(lpAddress =>
            Promise.all([
                readHub('getVault', [lpAddress]).catch(e => {
                    console.warn(`[Protocol Stats] Failed to fetch vault ${lpAddress}:`, e);
                    return null;
                }),
                readHub('getVaultDebt', [lpAddress]).catch(e => {
                    console.warn(`[Protocol Stats] Failed to fetch debt ${lpAddress}:`, e);
                    return null;
                }),
            ])
        )
    );

    // Sum across all active vaults
    let totalCollateral = 0n;
    let totalDebt = 0n;
    let totalMintFeeBps = 0;
    let totalBurnRewardBps = 0;
    let activeCount = 0;

    for (const [vault, vaultDebt] of vaultResults) {
        if (!vault || !vault.active) continue;
        totalCollateral += BigInt(vault.collateralShares.toString());
        if (vaultDebt !== null) totalDebt += BigInt(vaultDebt.toString());
        totalMintFeeBps += Number(vault.mintFeeBps);
        totalBurnRewardBps += Number(vault.burnRewardBps);
        activeCount++;
    }

    // Collateral ratio — convert stataUSDe shares to assets (share price > 1)
    let collateralAssets = totalCollateral;
    try {
        const publicClient = getPublicClient();
        const assets = await publicClient.readContract({
            address: CONTRACTS.stataUSDe,
            abi: [{ name: 'convertToAssets', type: 'function', stateMutability: 'view', inputs: [{ name: 'shares', type: 'uint256' }], outputs: [{ name: '', type: 'uint256' }] }],
            functionName: 'convertToAssets',
            args: [totalCollateral],
        });
        if (assets !== null && assets !== undefined) collateralAssets = BigInt(assets.toString());
    } catch (e) {
        console.warn('[Protocol Stats] convertToAssets failed, using shares as collateral:', e.message);
    }
    const collateralValueUsd = Number(formatUnits(collateralAssets, 18)) * collateralPrice;
    const debtValueUsd = Number(formatUnits(totalDebt, 8)) * xmrPrice;
    const collateralRatio = debtValueUsd > 0 ? (collateralValueUsd / debtValueUsd) * 100 : 0;

    // Fee/reward rates directly from vault settings (bps / 100 = percent)
    const avgMintFee = activeCount > 0 ? totalMintFeeBps / activeCount / 100 : 0;
    const avgBurnReward = activeCount > 0 ? totalBurnRewardBps / activeCount / 100 : 0;

    console.log('[Protocol Stats]', {
        activeVaults: activeCount,
        collateralRatio: Math.round(collateralRatio) + '%',
        avgMintFee: avgMintFee.toFixed(2) + '%',
        avgBurnReward: avgBurnReward.toFixed(2) + '%'
    });

    return { collateralRatio, avgMintFee, avgBurnReward };
}

function updateStatsUI(totalMinted, collateralRatio, avgMintFee, avgBurnReward) {
    const totalMintedEl = document.getElementById('total-minted');
    const collateralRatioEl = document.getElementById('collateral-ratio-stat');
    const avgMintFeeEl = document.getElementById('avg-mint-fee');
    const avgBurnRewardEl = document.getElementById('avg-burn-reward');

    if (totalMintedEl) {
        totalMintedEl.textContent = `${totalMinted.toFixed(6)} wsXMR`;
    }

    if (collateralRatioEl) {
        if (collateralRatio > 0) {
            collateralRatioEl.textContent = `${Math.round(collateralRatio)}%`;

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

    if (avgMintFeeEl) {
        avgMintFeeEl.textContent = `${avgMintFee.toFixed(2)}%`;
    }

    if (avgBurnRewardEl) {
        avgBurnRewardEl.textContent = `${avgBurnReward.toFixed(2)}%`;
    }
}
