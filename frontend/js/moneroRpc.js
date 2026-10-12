// Monero RPC Client
// Handles all Monero daemon and wallet RPC interactions

import { MONERO_CONFIG, LP_SERVER_CONFIG } from './config.js?v=3.12';

/**
 * Monero RPC Client for daemon and wallet operations
 * Supports multi-daemon fallback for resilience.
 */
class MoneroRpcClient {
    constructor(rpcUrl = null) {
        this.daemonUrls = rpcUrl
            ? [rpcUrl]
            : [...(MONERO_CONFIG.publicNodes?.mainnet || [MONERO_CONFIG.rpcUrl])];
        this.rpcUrl = rpcUrl || MONERO_CONFIG.rpcUrl;
        this.walletRpcUrl = null; // Set when wallet RPC is available
        this._connectedUrl = null;
    }

    /**
     * Try to find a responsive daemon from the configured list.
     * Returns the first URL that responds to a simple RPC call.
     */
    async _findWorkingDaemon() {
        for (const url of this.daemonUrls) {
            try {
                const controller = new AbortController();
                const timeout = setTimeout(() => controller.abort(), 8000);
                const res = await fetch(url + '/json_rpc', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ jsonrpc: '2.0', id: '0', method: 'get_block_count', params: {} }),
                    signal: controller.signal,
                });
                clearTimeout(timeout);
                if (res.ok) {
                    const data = await res.json();
                    if (!data.error && data.result) {
                        this._connectedUrl = url;
                        this.rpcUrl = url;
                        console.log(`[Monero RPC] Connected to ${url}`);
                        return url;
                    }
                }
            } catch {
                console.warn(`[Monero RPC] ${url} unreachable, trying next...`);
            }
        }
        throw new Error('All Monero daemons unreachable');
    }

    /**
     * Get the currently connected daemon URL (or find one if not yet connected).
     */
    async getConnectedUrl() {
        if (this._connectedUrl) return this._connectedUrl;
        return await this._findWorkingDaemon();
    }

    /**
     * Make RPC call to Monero daemon, with multi-daemon fallback.
     */
    async daemonRpc(method, params = {}) {
        // Ensure we have a connected daemon
        if (!this._connectedUrl) {
            await this._findWorkingDaemon();
        }

        const tryRpc = async (url) => {
            const response = await fetch(url + '/json_rpc', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ jsonrpc: '2.0', id: '0', method, params }),
            });
            if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
            const data = await response.json();
            if (data.error) throw new Error(`RPC error: ${data.error.message}`);
            return data.result;
        };

        try {
            return await tryRpc(this._connectedUrl);
        } catch (err) {
            console.warn(`[Monero RPC] ${this._connectedUrl} failed (${method}): ${err.message}, trying fallback...`);
            this._connectedUrl = null;
            await this._findWorkingDaemon();
            return await tryRpc(this._connectedUrl);
        }
    }

    /**
     * Get current blockchain height
     */
    async getHeight() {
        const result = await this.daemonRpc('get_block_count');
        return result.count;
    }

    /**
     * Get block by height
     */
    async getBlock(height) {
        const result = await this.daemonRpc('get_block', { height });
        return result;
    }

    /**
     * Get transaction by hash
     */
    async getTransaction(txHash) {
        try {
            if (!this._connectedUrl) await this._findWorkingDaemon();
            const url = this._connectedUrl;
            const response = await fetch(url + '/get_transactions', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    txs_hashes: [txHash],
                    decode_as_json: true
                })
            });

            const data = await response.json();
            
            if (data.status !== 'OK') {
                throw new Error(`Failed to get transaction: ${data.status}`);
            }

            return data.txs && data.txs.length > 0 ? data.txs[0] : null;
        } catch (error) {
            console.error('Error getting transaction:', error);
            throw error;
        }
    }

    /**
     * Scan for transactions to a specific address
     * This is a simplified version - full implementation requires wallet RPC
     */
    async scanForDeposit(address, expectedAmount, startHeight = null) {
        console.log(`Scanning for deposit to ${address} of ${expectedAmount} atomic units`);
        
        // Get current height
        const currentHeight = await this.getHeight();
        const scanStart = startHeight || (currentHeight - 100); // Scan last 100 blocks by default

        console.log(`Scanning blocks ${scanStart} to ${currentHeight}`);

        // Note: This is a simplified scan. Full implementation requires:
        // 1. Wallet RPC with view key to decrypt outputs
        // 2. Checking each transaction output in each block
        // 3. Verifying the output belongs to the target address
        
        // For production, this should be done by the LP server with full wallet access
        throw new Error('Deposit scanning requires wallet RPC - must be done by LP server');
    }

    /**
     * Verify a transaction exists on the blockchain and get its confirmation count
     */
    async verifyTransaction(txHash) {
        const tx = await this.getTransaction(txHash);
        if (!tx) {
            return { found: false, error: 'Transaction not found on blockchain' };
        }

        const blockHeight = tx.block_height;
        if (tx.in_pool || !blockHeight) {
            return { found: true, txHash, confirmations: 0, inPool: true };
        }

        const currentHeight = await this.getHeight();
        const confirmations = Math.max(0, currentHeight - blockHeight + 1);

        return {
            found: true,
            txHash,
            blockHeight,
            confirmations,
            inPool: false
        };
    }

    /**
     * Create a PTLC (Point Time Locked Contract) transaction
     * This requires custom Monero transaction building
     */
    async createPTLC(params) {
        const { 
            amount,           // Amount in atomic units
            recipientAddress, // Recipient's Monero address
            secretHash,       // Ed25519 commitment (keccak256 hash of public key)
            lockTime          // Timelock in blocks
        } = params;

        console.log('Creating PTLC transaction:', params);

        // PTLC creation requires:
        // 1. Custom transaction builder (not standard Monero)
        // 2. Adding extra field for secretHash verification
        // 3. Setting timelock for refund path
        // 4. Signing with sender's keys
        
        // This MUST be done by the LP server with full wallet access
        throw new Error('PTLC creation requires full wallet - must be done by LP server');
    }

    /**
     * Scan blockchain for PTLC with specific secretHash
     */
    async scanForPTLC(secretHash, startHeight = null) {
        console.log(`Scanning for PTLC with secretHash: ${secretHash}`);

        // Get current height
        const currentHeight = await this.getHeight();
        const scanStart = startHeight || (currentHeight - 100);

        console.log(`Scanning blocks ${scanStart} to ${currentHeight}`);

        // PTLC scanning requires:
        // 1. Wallet RPC to decrypt transaction extra fields
        // 2. Custom parsing of PTLC transaction format
        // 3. Verification that secretHash matches
        
        // For production, this should be done by the LP server
        throw new Error('PTLC scanning requires wallet RPC - must be done by LP server');
    }

    /**
     * Claim a PTLC by revealing the secret
     */
    async claimPTLC(ptlcTxHash, secret) {
        console.log(`Claiming PTLC ${ptlcTxHash} with secret`);

        // PTLC claiming requires:
        // 1. Building a transaction that spends the PTLC output
        // 2. Including the secret in the transaction
        // 3. Signing with recipient's keys
        
        // This MUST be done by the LP server or user's full wallet
        throw new Error('PTLC claiming requires full wallet - must be done by LP server');
    }

    /**
     * Check if a Monero address is valid
     */
    isValidAddress(address) {
        // Monero addresses are base58 encoded and have specific prefixes:
        // Mainnet: starts with 4
        // Testnet: starts with 9 or A
        // Stagenet: starts with 5
        
        if (!address || typeof address !== 'string') {
            return false;
        }

        // Basic validation
        if (address.length < 95 || address.length > 106) {
            return false;
        }

        // Check prefix
        const validPrefixes = ['4', '5', '9', 'A', 'B']; // Mainnet, Stagenet, Testnet
        if (!validPrefixes.includes(address[0])) {
            return false;
        }

        return true;
    }

    /**
     * Convert XMR to atomic units (piconero)
     */
    xmrToAtomic(xmr) {
        return BigInt(Math.floor(xmr * 1e12));
    }

    /**
     * Convert atomic units to XMR
     */
    atomicToXmr(atomic) {
        return Number(atomic) / 1e12;
    }
}

// Singleton instance
let rpcInstance = null;

/**
 * Get Monero RPC client instance
 */
export function getMoneroRpc() {
    if (!rpcInstance) {
        rpcInstance = new MoneroRpcClient();
    }
    return rpcInstance;
}

/** localStorage key for a user-supplied Monero node (e.g. a local monerod). */
const MONERO_NODE_KEY = 'monero-node-url';

/** Get the user-configured Monero node URL, or null. */
export function getMoneroNodeOverride() {
    try { return localStorage.getItem(MONERO_NODE_KEY) || null; } catch { return null; }
}

/** Persist a user-configured Monero node URL (empty string clears it). */
export function setMoneroNodeOverride(url) {
    try {
        if (url && url.trim()) localStorage.setItem(MONERO_NODE_KEY, url.trim());
        else localStorage.removeItem(MONERO_NODE_KEY);
    } catch {}
}

/**
 * Quick reachability + CORS probe for a daemon. monero-ts needs the node to
 * answer browser fetch() with permissive CORS — a node that responds to curl
 * may still be unusable from a browser. Returns true if the node answers.
 */
async function probeDaemon(url, timeoutMs = 6000) {
    try {
        const controller = new AbortController();
        const t = setTimeout(() => controller.abort(), timeoutMs);
        const res = await fetch(`${url}/get_info`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}',
            signal: controller.signal,
        });
        clearTimeout(t);
        return res.ok;
    } catch {
        return false;
    }
}

/**
 * Create a monero-ts MoneroWalletFull connected to a working daemon.
 * monero-ts needs a daemon that supports its binary endpoints (get_blocks.bin)
 * and permissive CORS — a node that answers /json_rpc may still fail. This tries
 * a user-configured node first, then each configured daemon, until the wallet
 * reports a live daemon connection.
 *
 * @param {Object} moneroTs - the monero-ts module (window.monero_ts)
 * @param {Object} walletConfig - createWalletFull config WITHOUT `server`
 * @param {Function} [onTry] - optional callback(url) before each attempt
 * @returns {Promise<{wallet: Object, daemonUrl: string}>}
 */
export async function createConnectedWalletFull(moneroTs, walletConfig, onTry) {
    const override = getMoneroNodeOverride();
    const configured = MONERO_CONFIG.publicNodes?.mainnet || [MONERO_CONFIG.rpcUrl];
    // LP-server proxy first (it forwards to a node and adds CORS for the browser),
    // then user override, then configured nodes (dedup).
    const proxyUrl = `${LP_SERVER_CONFIG.defaultUrl}/monero-daemon`;
    const urls = [...new Set([proxyUrl, ...(override ? [override] : []), ...configured])];

    let lastErr = null;
    for (const url of urls) {
        // Fast probe — skip nodes that don't answer a browser fetch (CORS/down)
        // instead of paying the createWalletFull + isConnectedToDaemon cost.
        if (!(await probeDaemon(url))) {
            console.warn(`[Monero RPC] ${url} failed probe (unreachable or CORS) — skipping`);
            lastErr = new Error(`Node unreachable or CORS-blocked (${url})`);
            continue;
        }

        let wallet = null;
        try {
            if (onTry) onTry(url);
            wallet = await moneroTs.createWalletFull({ ...walletConfig, server: url });
            // Verify the daemon connection is actually live — createWalletFull can
            // resolve without a usable daemon (binary endpoints / CORS blocked).
            let connected = false;
            try { connected = await wallet.isConnectedToDaemon(); } catch { connected = false; }
            if (!connected) {
                // Give the connection a brief moment then re-check once.
                await new Promise(r => setTimeout(r, 1500));
                try { connected = await wallet.isConnectedToDaemon(); } catch { connected = false; }
            }
            if (connected) {
                console.log(`[Monero RPC] monero-ts wallet connected via ${url}`);
                return { wallet, daemonUrl: url };
            }
            try { await wallet.close(); } catch {}
            lastErr = new Error(`Wallet is not connected to daemon (${url})`);
        } catch (e) {
            if (wallet) { try { await wallet.close(); } catch {} }
            lastErr = e;
            console.warn(`[Monero RPC] monero-ts wallet failed on ${url}: ${e.message}`);
        }
    }
    throw lastErr || new Error('No compatible Monero daemon found for the in-browser wallet');
}

/**
 * Set custom RPC URL (for testing or custom nodes)
 */
export function setMoneroRpcUrl(url) {
    rpcInstance = new MoneroRpcClient(url);
}
