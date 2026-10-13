/**
 * Co-LP Flow — Collateralized Liquidity Provider Position Manager
 *
 * Manages co-LP positions where users pair wsXMR with an LP vault's idle USDe collateral
 * to provide liquidity on Uniswap V3. Positions are represented as NFTs (UniV3 token IDs).
 *
 * Key operations: open (userOpenCoLP), unwind, rebalance, capacity check, preflight diagnostics.
 * Also includes helpers for querying active positions via on-chain event history.
 */

import { CONTRACTS, ABIS, DECIMALS } from './config.js?v=3.21';
import { readHub, writeHub, readWsxmr, writeWsxmr, getUserAddress, getPublicClient, getWalletClient } from './viemClient.js?v=3.21';
import { formatUnits, parseUnits, parseAbi, decodeEventLog, toEventSelector, encodeFunctionData, decodeFunctionResult } from 'https://esm.sh/viem@2.7.0';

// Co-LP event signatures — a single eth_getLogs query matches all three by
// OR'ing topic0. User binding differs per event (deployed: indexed topic2,
// unwound: indexed topic3, rebalanced: NON-indexed data arg) so events can't
// be uniformly server-filtered by user — decode + filter client-side instead.
const COLP_EVENT_ABI = parseAbi([
    'event CoLPDeployed(address indexed vault, address indexed user, uint256 indexed tokenId, uint256 usdeShares, uint256 wsxmrAmount, uint16 rangeBps)',
    'event CoLPUnwound(uint256 indexed tokenId, address indexed vault, address indexed user, uint256 usdeOut, uint256 wsxmrOut, bool fromLiquidation)',
    'event CoLPRebalanced(uint256 indexed oldTokenId, uint256 indexed newTokenId, address indexed vault, address user, address caller, uint16 newRangeBps)'
]);
const COLP_EVENT_TOPICS = COLP_EVENT_ABI.map(item => toEventSelector(item));

export class CoLPFlow {
    constructor() {
        this.userAddress = null;
    }

    /**
     * Initialize the CoLPFlow instance — stores the connected wallet address.
     * @returns {Promise<boolean>} true if wallet is connected
     */
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
        let pricesPushed = false;
        try {
            await this.updatePrices();
            pricesPushed = true;
        } catch (priceErr) {
            console.warn('⚠️ Could not update oracle prices:', priceErr.message);
        }

        // The push failing is only fatal if on-chain prices are actually
        // stale (>120s old → unwindCoLP reverts StalePrice). unwind reads
        // BOTH xmr and collateral price helpers, so check both before
        // burning gas on a doomed tx.
        if (!pricesPushed) {
            try {
                await Promise.all([
                    readHub('getXmrPriceWithAge', [120]),
                    readHub('getCollateralPriceWithAge', [120]),
                ]);
            } catch {
                throw new Error(
                    'Oracle price update failed and on-chain prices are stale (>2 min). ' +
                    'unwindCoLP would revert StalePrice. Reconnect the wallet that owns ' +
                    'this position and retry — the UI must push a fresh RedStone price first.'
                );
            }
        }

        const receipt = await writeHub('unwindCoLP', [BigInt(tokenId), BigInt(deadline)], 0n, 2000000n);
        console.log('Co-LP position unwound, tx:', receipt.transactionHash);
        return receipt;
    }

    /**
     * @notice Collect accrued UniV3 fees from a co-LP position.
     *         Fees land in pendingReturns: stataUSDe shares -> LP vault,
     *         wsXMR -> position user. Callable by vault owner or user.
     * @param {string|number} tokenId - V3 NFT token ID
     * @returns {Promise<Object>} transaction receipt
     */
    async collectCoLPFees(tokenId) {
        const receipt = await writeHub('collectCoLPFees', [BigInt(tokenId)]);
        console.log('Co-LP fees collected, tx:', receipt.transactionHash);
        return receipt;
    }

    /**
     * @notice Preview claimable fees for a co-LP position (no tx).
     *         Stateless eth_call on nfpm.collect() with the router spoofed as
     *         caller — the router owns the NFT, and eth_call doesn't verify
     *         signatures so the from-field satisfies isApprovedOrOwner.
     *         Pool token0 = USDe (vault owner's share), token1 = wsXMR (user's).
     * @param {string|number} tokenId - V3 NFT token ID
     * @returns {Promise<{wsxmr: bigint, usde: bigint}>} accrued unclaimed fees
     */
    async getClaimableFees(tokenId) {
        const MAX128 = (1n << 128n) - 1n;
        const collectAbi = parseAbi(['function collect((uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max) params) external returns (uint256 amount0, uint256 amount1)']);
        const data = encodeFunctionData({
            abi: collectAbi,
            functionName: 'collect',
            args: [{ tokenId: BigInt(tokenId), recipient: CONTRACTS.hub, amount0Max: MAX128, amount1Max: MAX128 }]
        });
        try {
            const { data: res } = await getPublicClient().call({
                account: CONTRACTS.liquidityRouter,
                to: CONTRACTS.nfpm,
                data
            });
            const [amount0, amount1] = decodeFunctionResult({ abi: collectAbi, functionName: 'collect', data: res });
            return { usde: amount0, wsxmr: amount1 };
        } catch (err) {
            console.warn(`getClaimableFees(${tokenId}) failed:`, err.shortMessage || err.message);
            return { usde: 0n, wsxmr: 0n };
        }
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
     * @notice Query user's active Co-LP positions from chain events.
     * Uses ONE chunked eth_getLogs for all three Co-LP signatures (previous
     * version ran three sequential 48k-block scans = 160+ RPC calls and sat
     * on "Loading positions..." for minutes). Decoded events are persisted to
     * localStorage so refreshes only scan new blocks.
     * @returns {Promise<Array<{tokenId: string, vault: string, wsxmrAmount: string, rangeBps: number}>>}
     */
    async getUserActivePositions() {
        if (!this.userAddress) return [];

        const publicClient = getPublicClient();
        const currentBlock = await publicClient.getBlockNumber();
        // Scan last ~2.75 days max (48,000 blocks) to stay within RPC provider limits
        const MAX_SCAN_BLOCKS = 48000n;
        let fromBlock = currentBlock > MAX_SCAN_BLOCKS ? currentBlock - MAX_SCAN_BLOCKS : 0n;

        const cache = this._loadScanCache();
        if (cache.lastBlock > 0) {
            // Resume where the last scan stopped, overlapping 100 blocks for
            // reorg safety (HyperEVM reorgs are rare and shallow).
            const resume = BigInt(cache.lastBlock) - 100n;
            if (resume > fromBlock) fromBlock = resume;
        }

        const me = this.userAddress.toLowerCase();
        const seen = new Set(cache.events.map(e => e.key));
        const freshEvents = [];
        const collectLogs = (logs, scannedTo) => {
            for (const log of logs) {
                const key = `${log.transactionHash}:${log.logIndex}`;
                if (seen.has(key)) continue;
                seen.add(key);
                const ev = this._serializeCoLPLog(log, me);
                if (ev) freshEvents.push(ev);
            }
            // Persist progress per chunk — a timed-out scan resumes here.
            this._saveScanCache(cache.events.concat(freshEvents), Number(scannedTo) + 1);
        };

        const { getLogsChunked } = await import('./viemClient.js?v=3.21');
        try {
            await getLogsChunked({
                address: CONTRACTS.hub,
                topics: [COLP_EVENT_TOPICS],
                fromBlock,
                toBlock: 'latest',
                onChunk: collectLogs
            });
        } catch (err) {
            // Fall back to whatever is cached — never leave the UI empty when
            // the RPC is just being flaky.
            console.warn('[coLPFlow] Event scan failed (using cached results):', err.shortMessage || err.message);
        }

        const active = this._buildActivePositions(cache.events.concat(freshEvents));
        if (active.length === 0) return active;

        // Verify each candidate against on-chain metadata. Cached deploy
        // events can outlive their position — a missed unwind event or a
        // cache written while pointed at a previous hub leaves a phantom
        // that renders forever. A tokenId with empty metadata is dead.
        const ZERO = '0x0000000000000000000000000000000000000000';
        const checks = await Promise.allSettled(
            active.map(p => readHub('getPositionMetadata', [BigInt(p.tokenId)]))
        );
        return active.filter((p, i) => {
            const r = checks[i];
            // RPC flake → keep the position rather than hide a real one.
            if (r.status !== 'fulfilled') return true;
            return r.value.vaultOwner && r.value.vaultOwner.toLowerCase() !== ZERO;
        });
    }

    /** localStorage key for the per-user Co-LP event scan cache. */
    _scanCacheKey() {
        // Namespaced by hub so a redeploy can't bleed stale events forward —
        // a deploy event from an old hub would otherwise render as a phantom
        // active position on the new one.
        return `colp-scan-v2-${(CONTRACTS.hub || '').toLowerCase()}-${(this.userAddress || '').toLowerCase()}`;
    }

    _loadScanCache() {
        try {
            const raw = JSON.parse(localStorage.getItem(this._scanCacheKey()) || 'null');
            if (raw && Array.isArray(raw.events)) {
                return { events: raw.events, lastBlock: raw.lastBlock || 0 };
            }
        } catch {}
        return { events: [], lastBlock: 0 };
    }

    _saveScanCache(events, lastBlock) {
        try {
            // Bound the cache — a user with >500 Co-LP events is far outside
            // expected usage; oldest are dropped.
            const evts = events.length > 500 ? events.slice(events.length - 500) : events;
            localStorage.setItem(this._scanCacheKey(), JSON.stringify({ events: evts, lastBlock }));
        } catch {}
    }

    /**
     * Decode a raw eth_getLogs entry into a cacheable Co-LP event, or null if
     * irrelevant. Keeps the user's own deploys plus ALL unwind/rebalance
     * events (tokenIds are global — needed for exclusion regardless of who
     * emitted them). bigint args are stringified for JSON storage.
     */
    _serializeCoLPLog(log, myAddr) {
        let decoded;
        try {
            decoded = decodeEventLog({ abi: COLP_EVENT_ABI, data: log.data, topics: log.topics });
        } catch { return null; }
        const { eventName, args } = decoded;
        if (!eventName || !args) return null;
        if (eventName === 'CoLPDeployed' && String(args.user).toLowerCase() !== myAddr) return null;
        const flat = {};
        for (const [k, v] of Object.entries(args)) flat[k] = typeof v === 'bigint' ? v.toString() : v;
        return {
            key: `${log.transactionHash}:${log.logIndex}`,
            eventName,
            args: flat,
            blockNumber: Number(log.blockNumber),
            txHash: log.transactionHash
        };
    }

    /**
     * Rebuild the active position list from cached serialized events.
     * Handles unwind exclusion, rebalance chains (a rebalance mints a NEW
     * tokenId with no CoLPDeployed — the position must be carried forward or
     * it vanishes from the UI), and multi-hop rebalance chains.
     */
    _buildActivePositions(events) {
        const me = this.userAddress.toLowerCase();
        const unwound = new Set();
        const rebalMap = new Map();   // oldId -> newId
        const rebalByNew = new Map(); // newId -> rebalance event
        const deployed = [];

        for (const ev of events) {
            if (ev.eventName === 'CoLPUnwound') {
                unwound.add(ev.args.tokenId);
            } else if (ev.eventName === 'CoLPRebalanced') {
                rebalMap.set(ev.args.oldTokenId, ev.args.newTokenId);
                rebalByNew.set(ev.args.newTokenId, ev);
            } else if (ev.eventName === 'CoLPDeployed' && String(ev.args.user).toLowerCase() === me) {
                deployed.push(ev);
            }
        }

        // An old tokenId rebalanced INTO an unwound tokenId is dead too.
        for (const [oldId, newId] of rebalMap) {
            if (unwound.has(newId)) unwound.add(oldId);
        }

        // newId -> oldId lookup for walking rebalance chains back to the
        // originating CoLPDeployed (A->B->C finds A for C).
        const rebalSrc = new Map();
        for (const [oldId, newId] of rebalMap) rebalSrc.set(newId, oldId);
        const rootOf = (id) => {
            let cur = id, hops = 0;
            while (rebalSrc.has(cur) && hops++ < 20) cur = rebalSrc.get(cur);
            return cur;
        };

        const deployedById = new Map(deployed.map(ev => [ev.args.tokenId, ev]));
        const activePositions = [];
        const push = (ev, tokenId, rangeBps, blockNumber) => activePositions.push({
            tokenId,
            vault: ev.args.vault,
            wsxmrAmount: (Number(ev.args.wsxmrAmount) / 1e8).toFixed(4),
            rangeBps: Number(rangeBps ?? ev.args.rangeBps),
            blockNumber: blockNumber ?? ev.blockNumber,
            txHash: ev.txHash
        });

        for (const ev of deployed) {
            const tokenId = ev.args.tokenId;
            if (unwound.has(tokenId) || rebalMap.has(tokenId)) continue;
            push(ev, tokenId);
        }

        // Carry positions forward through rebalances — new tokenIds have no
        // deployed event of their own.
        for (const [newId, rebalEv] of rebalByNew) {
            if (unwound.has(newId) || rebalMap.has(newId)) continue; // dead or superseded
            const src = deployedById.get(rootOf(newId));
            if (src) push(src, newId, rebalEv.args.newRangeBps, rebalEv.blockNumber);
        }

        activePositions.sort((a, b) => b.blockNumber - a.blockNumber);
        return activePositions;
    }

    /**
     * Extract the Uniswap V3 NFT token ID from transaction event logs.
     * Heuristic: looks for the last topic in multi-topic events within a plausible tokenId range.
     * @param {Array} logs - Transaction receipt logs
     * @returns {string|null} Token ID as string, or null if not found
     */
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
