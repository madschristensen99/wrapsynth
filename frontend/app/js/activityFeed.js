// Recent Activity Feed - Shows recent mints and burns from all users

import { getPublicClient } from './viemClient.js';
import { CONTRACTS } from './config.js';
import { parseAbi } from 'https://esm.sh/viem@2.7.0';

// Event ABI strings matching the deployed contract exactly
const HUB_EVENTS_ABI = parseAbi([
    'event MintInitiated(bytes32 indexed requestId, address indexed initiator, address indexed recipient, address lpVault, uint256 xmrAmount, uint256 wsxmrAmount, uint256 feeAmount, bytes32 claimCommitment, bytes32 userPublicKey, uint256 timeout)',
    'event MintFinalized(bytes32 indexed requestId, bytes32 secret)',
    'event MintCancelled(bytes32 indexed requestId)',
    'event BurnRequested(bytes32 indexed requestId, address indexed user, address indexed lpVault, uint256 wsxmrAmount, uint256 xmrAmount, uint256 rewardCollateral, bytes32 claimCommitment)',
    'event BurnCommitted(bytes32 indexed requestId, uint256 deadline)',
    'event BurnFinalized(bytes32 indexed requestId, bytes32 secret, uint256 reward)',
    'event BurnSlashed(bytes32 indexed requestId, address indexed user, uint256 totalSeized)',
    'event BurnCancelled(bytes32 indexed requestId)',
    'event VaultCreated(address indexed lp)',
    'event CollateralDeposited(address indexed lp, uint256 amount, uint256 shares)',
    'event CollateralWithdrawn(address indexed lp, uint256 amount, uint256 shares)',
    'event CoLPDeployed(address indexed vault, address indexed user, uint256 indexed tokenId, uint256 sDAIShares, uint256 wsxmrAmount, uint16 rangeBps)',
    'event CoLPUnwound(uint256 indexed tokenId, address indexed vault, address indexed user, uint256 daiReturned, uint256 wsxmrReturned, bool liquidationTriggered)',
    'event CoLPRebalanced(uint256 indexed oldTokenId, uint256 indexed newTokenId, address indexed vault, address user, address keeper, uint16 newRangeBps)'
]);

export async function loadRecentActivity() {
    const activityFeed = document.getElementById('activity-feed');
    if (!activityFeed) return;

    try {
        const publicClient = getPublicClient();
        const currentBlock = await publicClient.getBlockNumber();

        // Look back ~13.9 hours (~10000 blocks at 5s/block on Gnosis)
        // Must stay under RPC provider limits (typically 10k-50k blocks)
        const lookbackBlocks = 10000n;
        let fromBlock = currentBlock > lookbackBlocks ? currentBlock - lookbackBlocks : 0n;

        console.log('Fetching activity from block', fromBlock.toString(), 'to', currentBlock.toString());

        const hubAddress = CONTRACTS.hub;

        // Fetch all relevant events in parallel from hub (diamond)
        const [
            mintInitiated,
            mintFinalized,
            mintCancelled,
            burnRequested,
            burnCommitted,
            burnFinalized,
            burnSlashed,
            burnCancelled,
            vaultCreated,
            collateralDeposited,
            collateralWithdrawn,
            coLPDeployed,
            coLPUnwound,
            coLPRebalanced
        ] = await Promise.all([
            publicClient.getContractEvents({ address: hubAddress, abi: HUB_EVENTS_ABI, eventName: 'MintInitiated', fromBlock, toBlock: 'latest' }),
            publicClient.getContractEvents({ address: hubAddress, abi: HUB_EVENTS_ABI, eventName: 'MintFinalized', fromBlock, toBlock: 'latest' }),
            publicClient.getContractEvents({ address: hubAddress, abi: HUB_EVENTS_ABI, eventName: 'MintCancelled', fromBlock, toBlock: 'latest' }),
            publicClient.getContractEvents({ address: hubAddress, abi: HUB_EVENTS_ABI, eventName: 'BurnRequested', fromBlock, toBlock: 'latest' }),
            publicClient.getContractEvents({ address: hubAddress, abi: HUB_EVENTS_ABI, eventName: 'BurnCommitted', fromBlock, toBlock: 'latest' }),
            publicClient.getContractEvents({ address: hubAddress, abi: HUB_EVENTS_ABI, eventName: 'BurnFinalized', fromBlock, toBlock: 'latest' }),
            publicClient.getContractEvents({ address: hubAddress, abi: HUB_EVENTS_ABI, eventName: 'BurnSlashed', fromBlock, toBlock: 'latest' }),
            publicClient.getContractEvents({ address: hubAddress, abi: HUB_EVENTS_ABI, eventName: 'BurnCancelled', fromBlock, toBlock: 'latest' }),
            publicClient.getContractEvents({ address: hubAddress, abi: HUB_EVENTS_ABI, eventName: 'VaultCreated', fromBlock, toBlock: 'latest' }),
            publicClient.getContractEvents({ address: hubAddress, abi: HUB_EVENTS_ABI, eventName: 'CollateralDeposited', fromBlock, toBlock: 'latest' }),
            publicClient.getContractEvents({ address: hubAddress, abi: HUB_EVENTS_ABI, eventName: 'CollateralWithdrawn', fromBlock, toBlock: 'latest' }),
            publicClient.getContractEvents({ address: hubAddress, abi: HUB_EVENTS_ABI, eventName: 'CoLPDeployed', fromBlock, toBlock: 'latest' }),
            publicClient.getContractEvents({ address: hubAddress, abi: HUB_EVENTS_ABI, eventName: 'CoLPUnwound', fromBlock, toBlock: 'latest' }),
            publicClient.getContractEvents({ address: hubAddress, abi: HUB_EVENTS_ABI, eventName: 'CoLPRebalanced', fromBlock, toBlock: 'latest' })
        ]);

        const totalEvents = mintInitiated.length + mintFinalized.length + mintCancelled.length +
            burnRequested.length + burnCommitted.length + burnFinalized.length + burnSlashed.length + burnCancelled.length +
            vaultCreated.length + collateralDeposited.length + collateralWithdrawn.length +
            coLPDeployed.length + coLPUnwound.length + coLPRebalanced.length;
        console.log('Found', totalEvents, 'total events');

        // Combine, tag, and sort by block number (newest first)
        const allEvents = [
            ...mintInitiated.map(e => ({ ...e, type: 'mintInitiated' })),
            ...mintFinalized.map(e => ({ ...e, type: 'mintFinalized' })),
            ...mintCancelled.map(e => ({ ...e, type: 'mintCancelled' })),
            ...burnRequested.map(e => ({ ...e, type: 'burnRequested' })),
            ...burnCommitted.map(e => ({ ...e, type: 'burnCommitted' })),
            ...burnFinalized.map(e => ({ ...e, type: 'burnFinalized' })),
            ...burnSlashed.map(e => ({ ...e, type: 'burnSlashed' })),
            ...burnCancelled.map(e => ({ ...e, type: 'burnCancelled' })),
            ...vaultCreated.map(e => ({ ...e, type: 'vaultCreated' })),
            ...collateralDeposited.map(e => ({ ...e, type: 'collateralDeposited' })),
            ...collateralWithdrawn.map(e => ({ ...e, type: 'collateralWithdrawn' })),
            ...coLPDeployed.map(e => ({ ...e, type: 'coLPDeployed' })),
            ...coLPUnwound.map(e => ({ ...e, type: 'coLPUnwound' })),
            ...coLPRebalanced.map(e => ({ ...e, type: 'coLPRebalanced' }))
        ].sort((a, b) => {
            const blockDiff = Number(b.blockNumber - a.blockNumber);
            if (blockDiff !== 0) return blockDiff;
            // Same block: sort by log index descending
            return Number(b.logIndex - a.logIndex);
        });

        // Take only the 20 most recent
        const recentEvents = allEvents.slice(0, 20);

        console.log('Displaying', recentEvents.length, 'recent events');

        if (recentEvents.length === 0) {
            const emptyIcon = EVENT_ICONS.unknown;
            activityFeed.innerHTML = `
                <div class="activity-item activity-item--empty">
                    <div class="activity-badge" style="--badge-bg: ${emptyIcon.color}15; --badge-color: ${emptyIcon.color};">
                        ${emptyIcon.svg}
                    </div>
                    <div class="activity-content">
                        <div class="activity-title-row">
                            <strong>No recent activity</strong>
                        </div>
                        <span class="activity-time">Check back after the next transaction</span>
                    </div>
                </div>
            `;
            return;
        }

        activityFeed.innerHTML = recentEvents.map(event => renderActivityItem(event, currentBlock)).join('');

    } catch (error) {
        console.error('Error loading activity feed:', error);
        const errorIcon = EVENT_ICONS.unknown;
        activityFeed.innerHTML = `
            <div class="activity-item">
                <div class="activity-badge" style="--badge-bg: ${errorIcon.color}15; --badge-color: ${errorIcon.color};">
                    ${errorIcon.svg}
                </div>
                <div class="activity-content">
                    <div class="activity-title-row">
                        <strong>Error</strong>
                        <span class="activity-detail">— Failed to load activity</span>
                    </div>
                </div>
            </div>
        `;
    }
}

// SVG icons for each event type (16x16 stroke-based, Lucide-style)
const EVENT_ICONS = {
    mintInitiated: { svg: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/></svg>`, color: '#10b981' },
    mintFinalized: { svg: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>`, color: '#10b981' },
    mintCancelled: { svg: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>`, color: '#ef4444' },
    burnRequested: { svg: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/></svg>`, color: '#f97316' },
    burnCommitted: { svg: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`, color: '#3b82f6' },
    burnFinalized: { svg: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>`, color: '#10b981' },
    burnSlashed: { svg: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>`, color: '#dc2626' },
    burnCancelled: { svg: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>`, color: '#64748b' },
    vaultCreated: { svg: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>`, color: '#a855f7' },
    collateralDeposited: { svg: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 16 12 8"/><polyline points="8 12 12 8 16 12"/></svg>`, color: '#3b82f6' },
    collateralWithdrawn: { svg: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 8 12 16"/><polyline points="8 12 12 16 16 12"/></svg>`, color: '#64748b' },
    coLPDeployed: { svg: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="21" x2="9" y2="9"/></svg>`, color: '#8b5cf6' },
    coLPUnwound: { svg: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/><line x1="9" y1="9" x2="15" y2="15"/><line x1="15" y1="9" x2="9" y2="15"/></svg>`, color: '#ef4444' },
    coLPRebalanced: { svg: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M17 1l4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path d="M7 23l-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>`, color: '#f59e0b' },
    unknown: { svg: `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`, color: '#94a3b8' }
};

function getEventIcon(type) {
    return EVENT_ICONS[type] || EVENT_ICONS.unknown;
}

function renderActivityItem(event, currentBlock) {
    const args = event.args || {};
    const blocksAgo = Number(currentBlock - event.blockNumber);
    const timeAgo = formatBlocksAgo(blocksAgo);
    const icon = getEventIcon(event.type);

    let title = '';
    let detail = '';

    switch (event.type) {
        case 'mintInitiated': {
            const user = args.initiator || 'Unknown';
            const shortUser = user !== 'Unknown' ? `${user.slice(0, 6)}...${user.slice(-4)}` : 'Unknown';
            const xmrAmount = args.xmrAmount ? (Number(args.xmrAmount) / 1e12).toFixed(4) : '?';
            title = 'Mint Initiated';
            detail = `${xmrAmount} XMR by ${shortUser}`;
            break;
        }
        case 'mintFinalized': {
            const reqId = args.requestId ? `${args.requestId.slice(0, 6)}...${args.requestId.slice(-4)}` : 'Unknown';
            title = 'Mint Finalized';
            detail = `Request ${reqId}`;
            break;
        }
        case 'mintCancelled': {
            const reqId = args.requestId ? `${args.requestId.slice(0, 6)}...${args.requestId.slice(-4)}` : 'Unknown';
            title = 'Mint Cancelled';
            detail = `Request ${reqId}`;
            break;
        }
        case 'burnRequested': {
            const user = args.user || 'Unknown';
            const shortUser = user !== 'Unknown' ? `${user.slice(0, 6)}...${user.slice(-4)}` : 'Unknown';
            const wsxmrAmount = args.wsxmrAmount ? (Number(args.wsxmrAmount) / 1e8).toFixed(4) : '?';
            title = 'Burn Requested';
            detail = `${wsxmrAmount} wsXMR by ${shortUser}`;
            break;
        }
        case 'burnCommitted': {
            const reqId = args.requestId ? `${args.requestId.slice(0, 6)}...${args.requestId.slice(-4)}` : 'Unknown';
            title = 'Burn Committed';
            detail = `Request ${reqId}`;
            break;
        }
        case 'burnFinalized': {
            const reqId = args.requestId ? `${args.requestId.slice(0, 6)}...${args.requestId.slice(-4)}` : 'Unknown';
            title = 'Burn Finalized';
            detail = `Request ${reqId}`;
            break;
        }
        case 'burnSlashed': {
            const user = args.user || 'Unknown';
            const shortUser = user !== 'Unknown' ? `${user.slice(0, 6)}...${user.slice(-4)}` : 'Unknown';
            const seized = args.totalSeized ? (Number(args.totalSeized) / 1e18).toFixed(2) : '?';
            title = 'Burn Slashed';
            detail = `${seized} sDAI seized from ${shortUser}`;
            break;
        }
        case 'burnCancelled': {
            const reqId = args.requestId ? `${args.requestId.slice(0, 6)}...${args.requestId.slice(-4)}` : 'Unknown';
            title = 'Burn Cancelled';
            detail = `Request ${reqId}`;
            break;
        }
        case 'vaultCreated': {
            const lp = args.lp || 'Unknown';
            const shortLp = lp !== 'Unknown' ? `${lp.slice(0, 6)}...${lp.slice(-4)}` : 'Unknown';
            title = 'Vault Created';
            detail = `by ${shortLp}`;
            break;
        }
        case 'collateralDeposited': {
            const lp = args.lp || 'Unknown';
            const shortLp = lp !== 'Unknown' ? `${lp.slice(0, 6)}...${lp.slice(-4)}` : 'Unknown';
            const amount = args.amount ? (Number(args.amount) / 1e18).toFixed(2) : '?';
            title = 'Collateral Deposited';
            detail = `${amount} sDAI by ${shortLp}`;
            break;
        }
        case 'collateralWithdrawn': {
            const lp = args.lp || 'Unknown';
            const shortLp = lp !== 'Unknown' ? `${lp.slice(0, 6)}...${lp.slice(-4)}` : 'Unknown';
            const amount = args.amount ? (Number(args.amount) / 1e18).toFixed(2) : '?';
            title = 'Collateral Withdrawn';
            detail = `${amount} sDAI by ${shortLp}`;
            break;
        }
        case 'coLPDeployed': {
            const vault = args.vault || 'Unknown';
            const shortVault = vault !== 'Unknown' ? `${vault.slice(0, 6)}...${vault.slice(-4)}` : 'Unknown';
            const user = args.user || 'Unknown';
            const shortUser = user !== 'Unknown' ? `${user.slice(0, 6)}...${user.slice(-4)}` : 'Unknown';
            const sDAI = args.sDAIShares ? (Number(args.sDAIShares) / 1e18).toFixed(2) : '?';
            const wsxmr = args.wsxmrAmount ? (Number(args.wsxmrAmount) / 1e8).toFixed(4) : '?';
            const tokenId = args.tokenId?.toString() || '?';
            title = 'Co-LP Position Opened';
            detail = `Token #${tokenId} — ${sDAI} sDAI + ${wsxmr} wsXMR (${shortUser} + ${shortVault})`;
            break;
        }
        case 'coLPUnwound': {
            const tokenId = args.tokenId?.toString() || '?';
            const vault = args.vault || 'Unknown';
            const shortVault = vault !== 'Unknown' ? `${vault.slice(0, 6)}...${vault.slice(-4)}` : 'Unknown';
            const user = args.user || 'Unknown';
            const shortUser = user !== 'Unknown' ? `${user.slice(0, 6)}...${user.slice(-4)}` : 'Unknown';
            const daiRet = args.daiReturned ? (Number(args.daiReturned) / 1e18).toFixed(2) : '?';
            const wsxmrRet = args.wsxmrReturned ? (Number(args.wsxmrReturned) / 1e8).toFixed(4) : '?';
            const liq = args.liquidationTriggered ? ' (liquidation)' : '';
            title = 'Co-LP Position Unwound';
            detail = `Token #${tokenId} — ${daiRet} sDAI + ${wsxmrRet} wsXMR${liq}`;
            break;
        }
        case 'coLPRebalanced': {
            const oldTokenId = args.oldTokenId?.toString() || '?';
            const newTokenId = args.newTokenId?.toString() || '?';
            const vault = args.vault || 'Unknown';
            const shortVault = vault !== 'Unknown' ? `${vault.slice(0, 6)}...${vault.slice(-4)}` : 'Unknown';
            title = 'Co-LP Rebalanced';
            detail = `Token #${oldTokenId} → #${newTokenId} (${shortVault})`;
            break;
        }
        default: {
            title = 'Unknown Event';
            detail = '';
        }
    }

    return `
        <div class="activity-item">
            <div class="activity-badge" style="--badge-bg: ${icon.color}15; --badge-color: ${icon.color};">
                ${icon.svg}
            </div>
            <div class="activity-content">
                <div class="activity-title-row">
                    <strong>${title}</strong>
                    <span class="activity-detail">${detail ? '— ' + detail : ''}</span>
                </div>
                <span class="activity-time">${timeAgo}</span>
            </div>
        </div>
    `;
}

let hubWatcherUnsubscribe = null;

function handleNewActivityLogs(logs, publicClient) {
    const activityFeed = document.getElementById('activity-feed');
    if (!activityFeed) return;

    publicClient.getBlockNumber().then(currentBlock => {
        for (const log of logs) {
            const eventName = log.eventName;
            let type = eventName.charAt(0).toLowerCase() + eventName.slice(1);
            const eventItem = { ...log, type };
            const html = renderActivityItem(eventItem, currentBlock);

            const placeholder = activityFeed.querySelector('.activity-item--empty');
            if (placeholder) {
                activityFeed.innerHTML = html;
            } else {
                const temp = document.createElement('div');
                temp.innerHTML = html;
                const newItem = temp.firstElementChild;
                newItem.style.opacity = '0';
                newItem.style.transform = 'translateY(-8px)';
                newItem.style.transition = 'opacity 0.3s ease, transform 0.3s ease';
                activityFeed.insertBefore(newItem, activityFeed.firstChild);

                requestAnimationFrame(() => {
                    newItem.style.opacity = '1';
                    newItem.style.transform = 'translateY(0)';
                });

                while (activityFeed.children.length > 30) {
                    activityFeed.removeChild(activityFeed.lastChild);
                }
            }
        }
    }).catch(err => console.warn('Activity feed watcher block fetch failed:', err));
}

/**
 * Start watching for new events in real-time and prepend them to the feed.
 * Call this once during app init. Returns an unsubscribe function.
 */
export function startActivityFeedWatcher() {
    if (hubWatcherUnsubscribe) { hubWatcherUnsubscribe(); hubWatcherUnsubscribe = null; }

    try {
        const publicClient = getPublicClient();

        hubWatcherUnsubscribe = publicClient.watchContractEvent({
            address: CONTRACTS.hub,
            abi: HUB_EVENTS_ABI,
            pollingInterval: 4000,
            onLogs: (logs) => handleNewActivityLogs(logs, publicClient)
        });

        console.log('[Activity Feed] Real-time watcher started (hub)');
    } catch (error) {
        console.error('Failed to start activity feed watcher:', error);
    }

    return () => {
        if (hubWatcherUnsubscribe) { hubWatcherUnsubscribe(); hubWatcherUnsubscribe = null; }
    };
}

function formatBlocksAgo(blocks) {
    if (blocks === 0) return 'just now';
    if (blocks === 1) return '1 block ago';
    if (blocks < 12) return `${blocks} blocks ago`; // < 1 min
    
    const minutes = Math.floor(blocks / 12); // ~5s per block
    if (minutes < 60) return `${minutes}m ago`;
    
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
}

