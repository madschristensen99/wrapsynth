// LP Server HTTP Client
// NOTE: the mint/burn protocol is fully on-chain — the LP scans deposits itself
// (LP-viewable deposit addresses) and users confirm burns on-chain. This client
// only remains for optional LP-server conveniences (e.g. /info health checks);
// no user→LP messaging is required by the protocol.

import { LP_SERVER_CONFIG } from './config.js?v=3.12';

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
