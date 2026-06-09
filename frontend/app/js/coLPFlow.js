// Co-LP Flow - Collateralized Liquidity Provider Position Manager
// Connects to IVaultFacet (hub/diamond) for co-LP operations

import { CONTRACTS, ABIS, DECIMALS } from './config.js';
import { readHub, writeHub, readWsxmr, writeWsxmr, getUserAddress, getPublicClient, getWalletClient } from './viemClient.js';
import { formatUnits, parseUnits, parseAbi } from 'https://esm.sh/viem@2.7.0';

export class CoLPFlow {
    constructor() {
        this.userAddress = null;
    }

    async init() {
        this.userAddress = getUserAddress();
        if (!this.userAddress) {
            throw new Error('Wallet not connected');
        }
        return true;
    }

    /**
     * @notice Get the maximum wsXMR a vault can accept for co-LP
     * @param {string} lpVault - LP vault address
     * @returns {Promise<bigint>} maxWsxmrAcceptable
     */
    async getCoLPCapacity(lpVault) {
        const publicClient = getPublicClient();
        return await publicClient.readContract({
            address: CONTRACTS.hub,
            abi: parseAbi(ABIS.hub),
            functionName: 'getCoLPCapacity',
            args: [lpVault]
        });
    }

    /**
     * @notice User opens a co-LP position by pairing wsXMR against LP vault idle collateral
     * @param {string} lpVault - LP vault address
     * @param {number} wsxmrAmount - Amount of wsXMR to contribute (human readable)
     * @param {number} deadline - Unix timestamp deadline
     * @returns {Promise<Object>} transaction receipt with tokenId
     */
    async updatePrices() {
        const { updateOraclePrices } = await import('./redstoneWrapper.js?v=' + Date.now());
        await updateOraclePrices();
        console.log('✅ Oracle prices updated for Co-LP');
    }

    async userOpenCoLP(lpVault, wsxmrAmount, deadline) {
        // Push fresh prices first — getCoLPCapacity and userOpenCoLP both need them
        try {
            await this.updatePrices();
        } catch (priceErr) {
            console.warn('⚠️ Could not update oracle prices:', priceErr.message);
            console.log('ℹ️ Continuing anyway — transaction will revert if prices are stale');
        }

        const amount = parseUnits(wsxmrAmount, DECIMALS.wsXMR);

        // Run pre-flight diagnostics
        const preflight = await this.preflightUserOpenCoLP(lpVault, amount);
        if (!preflight.ok) {
            throw new Error(`Co-LP preflight failed:\n${preflight.issues.join('\n')}`);
        }

        // Check allowance before approving to avoid unnecessary txs
        const currentAllowance = await this.getWsxmrAllowance();
        if (currentAllowance < amount) {
            await writeWsxmr('approve', [CONTRACTS.hub, amount]);
        }

        // userOpenCoLP mints a UniV3 NFT — needs high gas limit
        const receipt = await writeHub('userOpenCoLP', [lpVault, amount, BigInt(deadline)], 0n, 2000000n);
        console.log('Co-LP position opened, tx:', receipt.transactionHash);

        // Try to extract tokenId from event logs
        const tokenId = this._extractTokenIdFromLogs(receipt.logs);
        if (tokenId !== null) {
            console.log('Co-LP tokenId:', tokenId);
        }

        return { receipt, tokenId };
    }

    /**
     * @notice Either LP or user closes a co-LP position
     * @param {string|number} tokenId - V3 NFT token ID
     * @param {number} deadline - Unix timestamp deadline
     * @returns {Promise<Object>} transaction receipt
     */
    async unwindCoLP(tokenId, deadline) {
        // Push fresh prices first — unwind reads oracle for tick calculations
        try {
            await this.updatePrices();
        } catch (priceErr) {
            console.warn('⚠️ Could not update oracle prices:', priceErr.message);
        }

        const receipt = await writeHub('unwindCoLP', [BigInt(tokenId), BigInt(deadline)], 0n, 2000000n);
        console.log('Co-LP position unwound, tx:', receipt.transactionHash);
        return receipt;
    }

    /**
     * @notice Keeper-callable rebalance when a position goes out of range
     * @param {string|number} tokenId - V3 NFT token ID
     * @param {number} newRangeBps - New range width in basis points (1000-10000)
     * @param {number} deadline - Unix timestamp deadline
     * @returns {Promise<Object>} transaction receipt
     */
    async rebalanceCoLP(tokenId, newRangeBps, deadline) {
        const receipt = await writeHub('rebalanceCoLP', [BigInt(tokenId), Number(newRangeBps), BigInt(deadline)]);
        console.log('Co-LP position rebalanced, tx:', receipt.transactionHash);
        return receipt;
    }

    /**
     * @notice LP sets the preferred max range width for co-LP positions
     * @param {number} newMaxBps - Range width in basis points (1000-10000)
     * @returns {Promise<Object>} transaction receipt
     */
    async setMaxCoLPRange(newMaxBps) {
        const receipt = await writeHub('setMaxCoLPRange', [Number(newMaxBps)]);
        console.log('Max Co-LP range updated, tx:', receipt.transactionHash);
        return receipt;
    }

    /**
     * @notice Get vault details including maxCoLPRangeBps
     * @param {string} lpVault - LP vault address
     * @returns {Promise<Object>} vault data tuple
     */
    async getVault(lpVault) {
        return await readHub('getVault', [lpVault]);
    }

    /**
     * @notice Run pre-flight diagnostics before userOpenCoLP and log everything
     * @param {string} lpVault - LP vault address
     * @param {bigint} amount - wsXMR amount in atomic units
     * @returns {Promise<{ok: boolean, issues: string[], data: Object}>}
     */
    async preflightUserOpenCoLP(lpVault, amount) {
        const publicClient = getPublicClient();
        const blockers = [];
        const warnings = [];
        const data = {};

        try {
            // 1. Vault state
            const vault = await this.getVault(lpVault);
            data.vault = vault;
            if (!vault.active) blockers.push(`Vault ${lpVault} is not active`);
            data.collateralShares = vault.collateralShares?.toString?.() ?? vault.collateralShares;
            data.lockedCollateral = vault.lockedCollateral?.toString?.() ?? vault.lockedCollateral;
            data.maxCoLPRangeBps = vault.maxCoLPRangeBps ?? vault[13]; // tuple index fallback

            // 2. Oracle prices (best-effort: view reads through diamond fallback often revert)
            try {
                const xmrPrice = await readHub('getXmrPrice');
                const collPrice = await readHub('getCollateralPrice');
                data.xmrPrice = xmrPrice.toString();
                data.collPrice = collPrice.toString();
                if (xmrPrice === 0n) warnings.push('XMR oracle price is 0 (likely stale)');
                if (collPrice === 0n) warnings.push('Collateral oracle price is 0 (likely stale)');
            } catch (oracleErr) {
                warnings.push(`Oracle price read failed — prices may be stale; transaction will revert if so`);
                data.xmrPrice = 'unavailable';
                data.collPrice = 'unavailable';
            }

            // 3. Pool initialization
            const poolAbi = ['function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)'];
            const slot0 = await publicClient.readContract({
                address: CONTRACTS.uniswapV3Pool, abi: parseAbi(poolAbi), functionName: 'slot0'
            });
            data.poolSqrtPriceX96 = slot0[0].toString();
            data.poolTick = slot0[1];
            if (slot0[0] === 0n) blockers.push('Uniswap V3 pool is not initialized (sqrtPriceX96 = 0)');

            // 4. Capacity
            const capacity = await this.getCoLPCapacity(lpVault);
            data.capacity = capacity.toString();
            if (capacity === 0n) blockers.push('Co-LP capacity is 0 (vault has no idle collateral)');
            if (capacity < amount) blockers.push(`Co-LP capacity (${capacity}) < requested amount (${amount})`);

            // 5. User balance
            const balance = await this.getWsxmrBalance();
            data.userBalance = balance.toString();
            if (balance < amount) blockers.push(`User wsXMR balance (${balance}) < requested amount (${amount})`);

            // 6. Allowance
            const allowance = await this.getWsxmrAllowance();
            data.userAllowance = allowance.toString();
            if (allowance < amount) warnings.push(`Allowance (${allowance}) < requested amount — approval will be submitted`);

            // 7. Amount sanity
            if (amount === 0n) blockers.push('Amount is 0');
            if (amount < 10000n) warnings.push('Amount < 0.0001 wsXMR — may be too small for UniV3');

            const issues = [...blockers, ...warnings.map(w => `[warn] ${w}`)];
            console.log('[CoLP Preflight] data:', data);
            console.log('[CoLP Preflight] blockers:', blockers);
            console.log('[CoLP Preflight] warnings:', warnings);

            return { ok: blockers.length === 0, issues, data };
        } catch (err) {
            blockers.push(`Preflight query failed: ${err.message}`);
            console.error('[CoLP Preflight] query error:', err);
            return { ok: false, issues: blockers, data };
        }
    }

    /**
     * @notice Check if user has an active vault (is an LP)
     * @returns {Promise<boolean>}
     */
    async isLP() {
        if (!this.userAddress) return false;
        const publicClient = getPublicClient();
        return await publicClient.readContract({
            address: CONTRACTS.hub,
            abi: parseAbi(ABIS.hub),
            functionName: 'hasActiveVault',
            args: [this.userAddress]
        });
    }

    /**
     * @notice Get user's wsXMR balance
     * @returns {Promise<bigint>}
     */
    async getWsxmrBalance() {
        if (!this.userAddress) return 0n;
        const publicClient = getPublicClient();
        return await publicClient.readContract({
            address: CONTRACTS.wsxmrToken,
            abi: parseAbi(ABIS.wsxmr),
            functionName: 'balanceOf',
            args: [this.userAddress]
        });
    }

    /**
     * @notice Get wsXMR allowance for hub
     * @returns {Promise<bigint>}
     */
    async getWsxmrAllowance() {
        if (!this.userAddress) return 0n;
        const publicClient = getPublicClient();
        return await publicClient.readContract({
            address: CONTRACTS.wsxmrToken,
            abi: parseAbi(ABIS.wsxmr),
            functionName: 'allowance',
            args: [this.userAddress, CONTRACTS.hub]
        });
    }

    /**
     * @notice Query user's active Co-LP positions from chain events
     * @returns {Promise<Array<{tokenId: string, vault: string, wsxmrAmount: string, rangeBps: number}>>}
     */
    async getUserActivePositions() {
        if (!this.userAddress) return [];

        const publicClient = getPublicClient();
        const currentBlock = await publicClient.getBlockNumber();
        // Scan last ~2.75 days max (48,000 blocks) to stay within RPC provider limits
        const MAX_SCAN_BLOCKS = 48000n;
        const fromBlock = currentBlock > MAX_SCAN_BLOCKS ? currentBlock - MAX_SCAN_BLOCKS : 0n;
        const safeFromBlock = fromBlock;

        const hubAbi = parseAbi([
            'event CoLPDeployed(address indexed vault, address indexed user, uint256 indexed tokenId, uint256 sDAIShares, uint256 wsxmrAmount, uint16 rangeBps)',
            'event CoLPUnwound(uint256 indexed tokenId, address indexed vault, address indexed user, uint256 daiOut, uint256 wsxmrOut, bool fromLiquidation)',
            'event CoLPRebalanced(uint256 indexed oldTokenId, uint256 indexed newTokenId, address indexed vault, address user, address caller, uint16 newRangeBps)'
        ]);

        // Query CoLPDeployed events for this user
        const deployedEvents = await publicClient.getContractEvents({
            address: CONTRACTS.hub,
            abi: hubAbi,
            eventName: 'CoLPDeployed',
            args: { user: this.userAddress },
            fromBlock: safeFromBlock,
            toBlock: 'latest'
        });

        // Query CoLPUnwound events for this user
        const unwoundEvents = await publicClient.getContractEvents({
            address: CONTRACTS.hub,
            abi: hubAbi,
            eventName: 'CoLPUnwound',
            args: { user: this.userAddress },
            fromBlock: safeFromBlock,
            toBlock: 'latest'
        });

        // Track rebalanced tokenIds: oldTokenId -> newTokenId
        const rebalanceMap = new Map(); // oldTokenId -> newTokenId
        const rebalanceEvents = await publicClient.getContractEvents({
            address: CONTRACTS.hub,
            abi: hubAbi,
            eventName: 'CoLPRebalanced',
            args: { user: this.userAddress },
            fromBlock: safeFromBlock,
            toBlock: 'latest'
        });
        for (const ev of rebalanceEvents) {
            rebalanceMap.set(ev.args.oldTokenId.toString(), ev.args.newTokenId.toString());
        }

        // Build set of unwound tokenIds (following rebalances)
        const unwoundTokenIds = new Set();
        for (const ev of unwoundEvents) {
            let tokenId = ev.args.tokenId.toString();
            // If this tokenId was the result of a rebalance, mark the chain
            unwoundTokenIds.add(tokenId);
        }

        // Also mark any oldTokenIds that were rebalanced INTO an unwound tokenId
        // as unwound (since they no longer exist)
        for (const [oldId, newId] of rebalanceMap) {
            if (unwoundTokenIds.has(newId)) {
                unwoundTokenIds.add(oldId);
            }
        }

        // Build active positions list
        const activePositions = [];
        for (const ev of deployedEvents) {
            const tokenId = ev.args.tokenId.toString();

            // Skip if directly unwound
            if (unwoundTokenIds.has(tokenId)) continue;

            // Skip if this tokenId was rebalanced into a new one (old one is dead)
            if (rebalanceMap.has(tokenId)) continue;

            activePositions.push({
                tokenId,
                vault: ev.args.vault,
                wsxmrAmount: (Number(ev.args.wsxmrAmount) / 1e8).toFixed(4),
                rangeBps: Number(ev.args.rangeBps),
                blockNumber: Number(ev.blockNumber),
                txHash: ev.transactionHash
            });
        }

        // Sort by most recent
        activePositions.sort((a, b) => b.blockNumber - a.blockNumber);

        return activePositions;
    }

    _extractTokenIdFromLogs(logs) {
        try {
            for (const log of logs) {
                // Look for PositionCreated or similar events with tokenId
                // The diamond may emit a Transfer event from NFPM or a custom event
                if (log.topics && log.topics.length >= 3) {
                    // This is heuristic; in practice the UI can query user positions after tx
                    const possibleTokenId = BigInt(log.topics[log.topics.length - 1]);
                    if (possibleTokenId > 0n && possibleTokenId < 2n ** 96n) {
                        return possibleTokenId.toString();
                    }
                }
            }
        } catch (e) {
            // ignore extraction errors
        }
        return null;
    }
}

let coLPFlowInstance = null;

export function getCoLPFlow() {
    if (!coLPFlowInstance) {
        coLPFlowInstance = new CoLPFlow();
    }
    return coLPFlowInstance;
}
