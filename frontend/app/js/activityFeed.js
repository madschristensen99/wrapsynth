// Recent Activity Feed - Shows recent mints and burns from all users

import { getPublicClient } from './viemClient.js';
import { CONTRACTS, ABIS } from './config.js';

export async function loadRecentActivity() {
    const activityFeed = document.getElementById('activity-feed');
    if (!activityFeed) return;

    try {
        const publicClient = await getPublicClient();
        const currentBlock = await publicClient.getBlockNumber();
        
        // Get events from deployment block (June 4, 2026)
        const fromBlock = 46400000n; // Deployment block estimate
        
        console.log('Fetching activity from block', fromBlock.toString(), 'to', currentBlock.toString());

        // Fetch recent mint, burn, and cancelled events
        const [mintEvents, burnEvents, cancelledEvents] = await Promise.all([
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
            }),
            publicClient.getLogs({
                address: CONTRACTS.hub,
                event: {
                    "anonymous": false,
                    "inputs": [
                        {"indexed": true, "internalType": "bytes32", "name": "requestId", "type": "bytes32"}
                    ],
                    "name": "MintCancelled",
                    "type": "event"
                },
                fromBlock,
                toBlock: currentBlock
            })
        ]);

        console.log('Found', mintEvents.length, 'mint events,', burnEvents.length, 'burn events, and', cancelledEvents.length, 'cancelled events');

        // Combine and sort by block number (newest first)
        const allEvents = [
            ...mintEvents.map(e => ({ ...e, type: 'mint' })),
            ...burnEvents.map(e => ({ ...e, type: 'burn' })),
            ...cancelledEvents.map(e => ({ ...e, type: 'cancelled' }))
        ].sort((a, b) => Number(b.blockNumber - a.blockNumber));

        // Take only the 10 most recent
        const recentEvents = allEvents.slice(0, 10);
        
        console.log('Displaying', recentEvents.length, 'recent events');

        if (recentEvents.length === 0) {
            activityFeed.innerHTML = `
                <div class="activity-item">
                    <span class="activity-icon">📭</span>
                    <span class="activity-text">No recent activity</span>
                </div>
            `;
            return;
        }

        activityFeed.innerHTML = recentEvents.map(event => {
            const icon = event.type === 'mint' ? '🔵' : event.type === 'burn' ? '🔴' : '❌';
            const action = event.type === 'mint' ? 'Mint' : event.type === 'burn' ? 'Burn' : 'Cancelled';
            const args = event.args || {};
            
            // Format amount (convert from atomic units)
            const xmrAmount = args.xmrAmount ? (Number(args.xmrAmount) / 1e12).toFixed(6) : event.type === 'cancelled' ? 'N/A' : '?';
            
            // Format address
            const user = args.initiator || args.user || 'Unknown';
            const shortUser = user !== 'Unknown' ? `${user.slice(0, 6)}...${user.slice(-4)}` : 'Unknown';
            
            // Calculate time ago
            const blocksAgo = Number(currentBlock - event.blockNumber);
            const timeAgo = formatBlocksAgo(blocksAgo);

            return `
                <div class="activity-item">
                    <span class="activity-icon">${icon}</span>
                    <span class="activity-text">
                        <strong>${action}</strong> ${xmrAmount} XMR by ${shortUser}
                        <span class="activity-time">${timeAgo}</span>
                    </span>
                </div>
            `;
        }).join('');

    } catch (error) {
        console.error('Error loading activity feed:', error);
        activityFeed.innerHTML = `
            <div class="activity-item">
                <span class="activity-icon">⚠️</span>
                <span class="activity-text">Failed to load activity</span>
            </div>
        `;
    }
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

// Add CSS for activity feed
const style = document.createElement('style');
style.textContent = `
    .activity-feed {
        display: flex;
        flex-direction: column;
        gap: 0.75rem;
        max-height: 400px;
        overflow-y: auto;
    }

    .activity-item {
        display: flex;
        align-items: flex-start;
        gap: 0.75rem;
        padding: 0.75rem;
        background: rgba(255, 255, 255, 0.02);
        border-radius: 8px;
        transition: background 0.2s ease;
    }

    .activity-item:hover {
        background: rgba(255, 255, 255, 0.04);
    }

    .activity-icon {
        font-size: 1.25rem;
        flex-shrink: 0;
    }

    .activity-text {
        flex: 1;
        font-size: 0.875rem;
        line-height: 1.5;
        display: flex;
        flex-direction: column;
        gap: 0.25rem;
    }

    .activity-text strong {
        color: var(--text-primary);
    }

    .activity-time {
        font-size: 0.75rem;
        color: var(--text-secondary);
    }

    .activity-feed::-webkit-scrollbar {
        width: 6px;
    }

    .activity-feed::-webkit-scrollbar-track {
        background: rgba(255, 255, 255, 0.05);
        border-radius: 3px;
    }

    .activity-feed::-webkit-scrollbar-thumb {
        background: rgba(255, 255, 255, 0.2);
        border-radius: 3px;
    }

    .activity-feed::-webkit-scrollbar-thumb:hover {
        background: rgba(255, 255, 255, 0.3);
    }
`;
document.head.appendChild(style);
