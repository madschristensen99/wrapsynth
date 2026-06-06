// Swap History Display

import { loadSwapHistory } from './storage.js';
import { getIconSVG } from './icons.js';

export async function displaySwapHistory() {
    const historyList = document.getElementById('swap-history-list');
    if (!historyList) return;

    // Load history from localStorage (wallet-independent)
    const history = loadSwapHistory();
    
    if (!history || history.length === 0) {
        historyList.innerHTML = '<p style="text-align: center; color: var(--text-secondary); padding: 2rem;">No transactions yet. Start your first mint or burn!</p>';
        return;
    }

    // Sort by timestamp (newest first)
    const sortedHistory = history.sort((a, b) => (b.completedAt || b.timestamp || 0) - (a.completedAt || a.timestamp || 0));

    historyList.innerHTML = sortedHistory.map(swap => {
        const status = getStatusDisplay(swap.status || swap.state);
        const type = swap.type === 'mint' ? 'Mint' : 'Burn';
        const amount = swap.xmrAmount || swap.amount || '0';
        const timestamp = formatTimestamp(swap.completedAt || swap.timestamp);
        const requestId = swap.requestId ? swap.requestId.slice(0, 8) + '...' : 'N/A';

        return `
            <div class="history-item ${status.className}">
                <div class="history-header">
                    <span class="history-type">${status.icon} ${type}</span>
                    <span class="history-status ${status.className}">${status.text}</span>
                </div>
                <div class="history-details">
                    <div class="history-detail">
                        <span class="detail-label">Amount:</span>
                        <span class="detail-value">${amount} XMR</span>
                    </div>
                    <div class="history-detail">
                        <span class="detail-label">Request ID:</span>
                        <span class="detail-value" style="font-family: 'JetBrains Mono', monospace; font-size: 0.85em;">${requestId}</span>
                    </div>
                    <div class="history-detail">
                        <span class="detail-label">Time:</span>
                        <span class="detail-value">${timestamp}</span>
                    </div>
                </div>
            </div>
        `;
    }).join('');
}

function getStatusDisplay(status) {
    const statusMap = {
        'Completed': { text: 'Completed', icon: getIconSVG('check-circle'), className: 'status-completed' },
        'completed': { text: 'Completed', icon: getIconSVG('check-circle'), className: 'status-completed' },
        'Cancelled': { text: 'Cancelled', icon: getIconSVG('x-circle'), className: 'status-cancelled' },
        'cancelled': { text: 'Cancelled', icon: getIconSVG('x-circle'), className: 'status-cancelled' },
        'Expired': { text: 'Expired', icon: getIconSVG('clock'), className: 'status-expired' },
        'expired': { text: 'Expired', icon: getIconSVG('clock'), className: 'status-expired' },
        'Failed': { text: 'Failed', icon: getIconSVG('alert-triangle'), className: 'status-failed' },
        'failed': { text: 'Failed', icon: getIconSVG('alert-triangle'), className: 'status-failed' },
    };

    return statusMap[status] || { text: status || 'Unknown', icon: getIconSVG('circle'), className: 'status-unknown' };
}

function formatTimestamp(timestamp) {
    if (!timestamp) return 'Unknown';
    
    const date = new Date(timestamp);
    const now = new Date();
    const diffMs = now - date;
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    
    return date.toLocaleDateString();
}

// Add CSS for history items
const style = document.createElement('style');
style.textContent = `
    .swap-history-list {
        display: flex;
        flex-direction: column;
        gap: 0.75rem;
    }

    .history-item {
        background: rgba(255, 255, 255, 0.6);
        backdrop-filter: blur(10px);
        border: 1px solid rgba(0, 0, 0, 0.08);
        border-radius: 12px;
        padding: 1rem 1.25rem;
        transition: all 0.2s ease;
    }

    .history-item:hover {
        background: rgba(255, 255, 255, 0.75);
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08);
    }

    .history-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 0.75rem;
    }

    .history-type {
        font-weight: 700;
        font-size: 1rem;
        display: flex;
        align-items: center;
        gap: 0.5rem;
        color: #1f2937;
    }

    .history-type svg {
        width: 18px;
        height: 18px;
        flex-shrink: 0;
    }

    .history-status {
        font-size: 0.8125rem;
        padding: 0.375rem 0.875rem;
        border-radius: 20px;
        font-weight: 600;
        letter-spacing: 0.025em;
    }

    .status-completed {
        background: #d1fae5;
        color: #065f46;
    }

    .status-cancelled {
        background: #fee2e2;
        color: #991b1b;
    }

    .status-expired {
        background: #fef3c7;
        color: #92400e;
    }

    .status-failed {
        background: #fee2e2;
        color: #991b1b;
    }

    .history-details {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
        gap: 0.5rem;
    }

    .history-detail {
        display: flex;
        flex-direction: column;
        gap: 0.25rem;
    }

    .detail-label {
        font-size: 0.6875rem;
        color: #6b7280;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        font-weight: 700;
    }

    .detail-value {
        font-size: 0.9375rem;
        color: #111827;
        font-weight: 600;
        font-family: 'JetBrains Mono', 'SF Mono', 'Monaco', monospace;
    }
`;
document.head.appendChild(style);
