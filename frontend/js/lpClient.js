// LP Server HTTP Client
// Handles communication with the LP server for quotes, notifications, and status polling

import { LP_SERVER_CONFIG } from './config.js';

export class LPClient {
    constructor(baseUrl = LP_SERVER_CONFIG.defaultUrl) {
        this.baseUrl = baseUrl;
    }

    async request(endpoint, options = {}) {
        const url = `${this.baseUrl}${endpoint}`;
        try {
            const response = await fetch(url, {
                headers: {
                    'Content-Type': 'application/json',
                    ...options.headers
                },
                ...options
            });

            if (!response.ok) {
                const error = await response.json().catch(() => ({ error: response.statusText }));
                throw new Error(error.error || `HTTP ${response.status}`);
            }

            return await response.json();
        } catch (error) {
            console.error(`LP Server request failed: ${endpoint}`, error);
            throw error;
        }
    }

    async info() {
        return this.request(LP_SERVER_CONFIG.endpoints.info);
    }

    async quoteMint({ xmrAmount, userAddress }) {
        return this.request(LP_SERVER_CONFIG.endpoints.quoteMint, {
            method: 'POST',
            body: JSON.stringify({
                xmr_amount: xmrAmount,
                user_address: userAddress
            })
        });
    }

    async quoteBurn({ wsxmrAmount, userAddress }) {
        return this.request(LP_SERVER_CONFIG.endpoints.quoteBurn, {
            method: 'POST',
            body: JSON.stringify({
                wsxmr_amount: wsxmrAmount,
                user_address: userAddress
            })
        });
    }

    async notifyMint({ requestId, txHash }) {
        return this.request(LP_SERVER_CONFIG.endpoints.notifyMint, {
            method: 'POST',
            body: JSON.stringify({
                request_id: requestId,
                tx_hash: txHash
            })
        });
    }

    async getMintStatus(requestId) {
        // Strip 0x prefix if present
        const cleanId = requestId.startsWith('0x') ? requestId.slice(2) : requestId;
        const endpoint = LP_SERVER_CONFIG.endpoints.getMintStatus.replace(':id', cleanId);
        return this.request(endpoint);
    }

    async getBurnStatus(requestId) {
        // Strip 0x prefix if present
        const cleanId = requestId.startsWith('0x') ? requestId.slice(2) : requestId;
        const endpoint = LP_SERVER_CONFIG.endpoints.getBurnStatus.replace(':id', cleanId);
        return this.request(endpoint);
    }

    isAvailable() {
        return this.baseUrl !== 'http://localhost:3001' || this.baseUrl.includes('localhost');
    }
}

let lpClientInstance = null;

export function getLPClient(baseUrl) {
    if (!lpClientInstance || (baseUrl && lpClientInstance.baseUrl !== baseUrl)) {
        lpClientInstance = new LPClient(baseUrl);
    }
    return lpClientInstance;
}
