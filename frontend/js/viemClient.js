// Viem client setup for EVM interactions
// Uses createPublicClient and createWalletClient as required

import { createPublicClient, createWalletClient, custom, http, fallback, parseAbi, defineChain } from 'https://esm.sh/viem@2.7.0';
import { NETWORKS, CONTRACTS, ABIS, RAW_ABIS } from './config.js?v=3.22';

// HyperEVM mainnet (chainId 999) — not a built-in viem chain, so define it.
export const hyperevm = defineChain({
    id: 999,
    name: 'HyperEVM',
    nativeCurrency: { name: 'HYPE', symbol: 'HYPE', decimals: 18 },
    rpcUrls: { default: { http: ['https://rpc.hyperliquid.xyz/evm'] } },
    blockExplorers: { default: { name: 'HyperEVM Scan', url: 'https://hyperevmscan.io' } }
});

// Parse ABIs once at module level
// Append burn resolution functions that may be missing from cached config.js
const _extraHubAbi = parseAbi([
    'function abortBurn(bytes32 requestId) external',
    'function forceSettleBurn(bytes32 requestId) external',
    'function resolveDeclinedProposal(bytes32 requestId, bytes32 userSecret) external',
    'function abandonedBurns(bytes32 requestId) external view returns (bool)',
    'function getVaultBurnRequests(address vault) external view returns (bytes32[])'
]);
export const parsedABIs = {
    hub: [...parseAbi(ABIS.hub), ..._extraHubAbi],
    wsxmr: parseAbi(ABIS.wsxmr),
    liquidityRouter: parseAbi(ABIS.liquidityRouter)
};

// Public client for reading blockchain state
let publicClient = null;

// Wallet client for signing transactions
let walletClient = null;

// Current user address
let userAddress = null;

/**
 * Initialize viem clients
 */
function getTransport() {
    const timeout = 10000; // 10s — prevent slow RPC from blocking UI
    const retryOpts = { retryCount: 1, retryDelay: 200, timeout };
    const httpTransports = NETWORKS.hyperevm.rpcUrls.map(url => http(url, retryOpts));
    // Reads go ONLY to HTTP RPCs. Never route reads through window.ethereum:
    // wallet extensions (Ambire, MetaMask) forward eth_getLogs to their own
    // RPC endpoints, which are CORS-blocked/rate-limited and spam
    // "Failed to fetch" errors. Writes still go through walletClient.
    // rank: false — ranking pings EVERY transport periodically, which
    // needlessly hammers rate-limited endpoints.
    return fallback(httpTransports, { retryCount: 2 });
}

export async function initializeClients() {
    // Create public client with HTTP RPCs first, MetaMask as fallback
    publicClient = createPublicClient({
        chain: hyperevm,
        transport: getTransport()
    });

    // Create wallet client using MetaMask if available
    if (typeof window.ethereum !== 'undefined') {
        walletClient = createWalletClient({
            chain: hyperevm,
            transport: custom(window.ethereum)
        });
    }

    return { publicClient, walletClient };
}

/**
 * Connect to MetaMask and get user address
 */
export async function connectWallet() {
    if (!walletClient) {
        await initializeClients();
    }

    // Request account access
    const [address] = await walletClient.requestAddresses();
    userAddress = address;

    // Recreate wallet client with the account so writeContract works reliably
    walletClient = createWalletClient({
        account: address,
        chain: hyperevm,
        transport: custom(window.ethereum)
    });

    // Ensure we're on the correct network
    await switchToHyperEvmChain();

    // Mark that the user has explicitly connected so we can auto-reconnect next visit
    localStorage.setItem('wrapsynth-wallet-connected', 'true');

    return address;
}

/**
 * Switch to HyperEVM if not already connected
 */
async function switchToHyperEvmChain() {
    try {
        await window.ethereum.request({
            method: 'wallet_switchEthereumChain',
            params: [{ chainId: '0x3e7' }], // 999 in hex
        });
    } catch (switchError) {
        // Chain not added, add it
        if (switchError.code === 4902) {
            await window.ethereum.request({
                method: 'wallet_addEthereumChain',
                params: [{
                    chainId: '0x3e7',
                    chainName: NETWORKS.hyperevm.name,
                    nativeCurrency: NETWORKS.hyperevm.nativeCurrency,
                    rpcUrls: NETWORKS.hyperevm.rpcUrls,
                    blockExplorerUrls: [NETWORKS.hyperevm.blockExplorer]
                }]
            });
        } else {
            throw switchError;
        }
    }
}

/**
 * Disconnect the wallet — clears local session state and asks the wallet to
 * revoke this site's account permission (MetaMask honors wallet_revokePermissions;
 * wallets that don't support it still get a clean local disconnect).
 */
export async function disconnectWallet() {
    try {
        await window.ethereum?.request({
            method: 'wallet_revokePermissions',
            params: [{ eth_accounts: {} }]
        });
    } catch { /* wallet doesn't support revoke — local disconnect is enough */ }
    userAddress = null;
    localStorage.removeItem('wrapsynth-wallet-connected');
    if (typeof window.ethereum !== 'undefined') {
        walletClient = createWalletClient({
            chain: hyperevm,
            transport: custom(window.ethereum)
        });
    }
}

/**
 * Get current user address
 */
export function getUserAddress() {
    return userAddress;
}

/**
 * Ensure the wallet has authorized an account for THIS origin.
 * eth_sendTransaction throws 4100 'account has not been authorized' when
 * `from` isn't in the wallet's authorized set for the site — happens when
 * the cached userAddress is stale (permissions expired, different account
 * connected, first visit to a new origin like the live domain).
 * Re-requests authorization and syncs userAddress + walletClient to
 * whatever the wallet actually returns.
 */
export async function ensureAuthorizedAccount() {
    if (!window.ethereum) throw new Error('No wallet provider found');
    let accounts = await window.ethereum.request({ method: 'eth_accounts' });
    if (!accounts || accounts.length === 0) {
        accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
    }
    if (!accounts || accounts.length === 0) {
        throw new Error('Wallet did not authorize an account');
    }
    if (!userAddress || userAddress.toLowerCase() !== accounts[0].toLowerCase()) {
        // Cached address is stale or was never authorized on this origin
        userAddress = accounts[0];
        walletClient = createWalletClient({
            account: userAddress,
            chain: hyperevm,
            transport: custom(window.ethereum)
        });
    }
    return accounts[0];
}

/**
 * Ensure wallet is connected. Silently tries to get the current address
 * from MetaMask without prompting if already authorized.
 */
export async function ensureConnected() {
    if (userAddress) {
        // Revalidate the cached address against the wallet's authorized
        // accounts — a stale one passes all reads (wrong user's data) but
        // every send dies with 4100.
        try {
            const acc = await window.ethereum?.request({ method: 'eth_accounts' });
            if (acc && acc.length > 0 && acc[0].toLowerCase() !== userAddress.toLowerCase()) {
                userAddress = acc[0];
                walletClient = createWalletClient({
                    account: userAddress,
                    chain: hyperevm,
                    transport: custom(window.ethereum)
                });
            }
        } catch { /* non-fatal */ }
        return userAddress;
    }
    if (!walletClient || !window.ethereum) return null;

    // Only try silent reconnect if user has previously connected via the app.
    // This avoids unwanted wallet prompts for first-time visitors.
    const hasConnectedBefore = localStorage.getItem('wrapsynth-wallet-connected') === 'true';
    if (!hasConnectedBefore) return null;

    try {
        const accounts = await window.ethereum.request({ method: 'eth_accounts' });
        if (accounts && accounts.length > 0) {
            userAddress = accounts[0];
            walletClient = createWalletClient({
                account: userAddress,
                chain: hyperevm,
                transport: custom(window.ethereum)
            });
            // Ensure wallet is on HyperEVM after silent reconnect
            await switchToHyperEvmChain();
            return userAddress;
        }
    } catch (e) {
        console.warn('ensureConnected failed:', e.message);
    }
    return null;
}

/**
 * Get public client
 */
export function getPublicClient() {
    if (!publicClient) {
        throw new Error('Public client not initialized');
    }
    return publicClient;
}

/**
 * Get wallet client
 */
export function getWalletClient() {
    if (!walletClient) {
        throw new Error('Wallet client not initialized');
    }
    return walletClient;
}

/**
 * Read from Hub contract (Diamond)
 */
export async function readHub(functionName, args = []) {
    const client = getPublicClient();
    
    // Special handling for functions with tuple return types
    if (functionName === 'getVault') {
        return await client.readContract({
            address: CONTRACTS.hub,
            abi: [RAW_ABIS.getVault],
            functionName,
            args
        });
    }
    if (functionName === 'getMintRequest') {
        return await client.readContract({
            address: CONTRACTS.hub,
            abi: [RAW_ABIS.getMintRequest],
            functionName,
            args
        });
    }
    if (functionName === 'getBurnRequest') {
        return await client.readContract({
            address: CONTRACTS.hub,
            abi: [RAW_ABIS.getBurnRequest],
            functionName,
            args
        });
    }
    if (functionName === 'getPositionMetadata') {
        return await client.readContract({
            address: CONTRACTS.hub,
            abi: [RAW_ABIS.getPositionMetadata],
            functionName,
            args
        });
    }
    
    return await client.readContract({
        address: CONTRACTS.hub,
        abi: parsedABIs.hub,
        functionName,
        args
    });
}

/**
 * Write to Hub contract (Diamond)
 * @param {string} functionName - Contract function name
 * @param {Array} args - Function arguments
 * @param {bigint} value - ETH value to send (default: 0n)
 * @param {bigint} gas - Optional gas limit override
 */
/**
 * Wait for a mined receipt and throw if the tx reverted on-chain.
 * waitForTransactionReceipt returns a receipt for reverted txs too —
 * without this check, every caller treats a failed tx as success.
 */
async function waitMinedOrThrow(hash, label) {
    const receipt = await getPublicClient().waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') {
        throw new Error(`${label || 'Transaction'} reverted on-chain (tx ${hash})`);
    }
    return receipt;
}

export async function writeHub(functionName, args = [], value = 0n, gas = undefined) {
    const account = await ensureAuthorizedAccount();
    const { encodeFunctionData } = await import('https://esm.sh/viem@2.7.0');

    const data = encodeFunctionData({
        abi: parsedABIs.hub,
        functionName,
        args,
    });

    const gasHex = gas ? '0x' + gas.toString(16) : undefined;

    // Send directly via wallet provider to bypass viem transport InternalRpcError.
    // Only the SEND is wrapped — the receipt wait stays outside so a wait-time
    // RPC flake or a mined-and-reverted tx can't trigger a duplicate submission.
    let hash;
    try {
        const txParams = {
            from: account,
            to: CONTRACTS.hub,
            data,
        };
        if (gasHex) txParams.gas = gasHex;
        if (value > 0n) txParams.value = '0x' + value.toString(16);

        hash = await window.ethereum.request({
            method: 'eth_sendTransaction',
            params: [txParams]
        });
    } catch (directErr) {
        // Fall back to viem simulate + writeContract
        console.warn('[writeHub] Direct send failed, falling back to simulate:', directErr.message);
        const client = getWalletClient();
        const simOpts = {
            address: CONTRACTS.hub,
            abi: parsedABIs.hub,
            functionName,
            args,
            value,
            account: userAddress
        };
        if (gas !== undefined) simOpts.gas = gas;
        const { request } = await getPublicClient().simulateContract(simOpts);
        hash = await client.writeContract({ ...request, account: userAddress });
    }

    return waitMinedOrThrow(hash, functionName);
}

/**
 * Write to hub contract WITHOUT simulation — useful when RPC simulation
 * fails with "internal error" on complex diamond proxy calls.
 * @param {string} functionName
 * @param {array} args
 * @param {bigint} value
 * @param {bigint} gas
 */
export async function writeHubUnsafe(functionName, args = [], value = 0n, gas = 3000000n) {
    const client = getWalletClient();
    const account = getUserAddress();

    const { encodeFunctionData } = await import('https://esm.sh/viem@2.7.0');

    const data = encodeFunctionData({
        abi: parsedABIs.hub,
        functionName,
        args,
    });

    const nonce = await getPublicClient().getTransactionCount({ address: account });

    const serializedTx = await client.signTransaction({
        account,
        chain: hyperevm,
        to: CONTRACTS.hub,
        data,
        value,
        gas,
        gasPrice: 1000000000n,
        nonce,
    });

    const rpcUrls = NETWORKS.hyperevm.rpcUrls;
    let hash;
    let lastErr;
    for (const rpcUrl of rpcUrls) {
        try {
            console.log(`[writeHubUnsafe] Trying RPC: ${rpcUrl}...`);
            const altClient = createPublicClient({
                chain: hyperevm,
                transport: http(rpcUrl, { retryCount: 1, timeout: 15000 })
            });
            hash = await altClient.sendRawTransaction({ serializedTransaction: serializedTx });
            console.log(`[writeHubUnsafe] Accepted by ${rpcUrl}`);
            break;
        } catch (err) {
            console.warn(`[writeHubUnsafe] RPC ${rpcUrl} failed:`, err.message);
            lastErr = err;
        }
    }
    if (!hash) throw lastErr;

    return waitMinedOrThrow(hash, functionName);
}

/**
 * Read from wsXMR token contract
 */
export async function readWsxmr(functionName, args = []) {
    const client = getPublicClient();
    
    return await client.readContract({
        address: CONTRACTS.wsxmrToken,
        abi: parsedABIs.wsxmr,
        functionName,
        args
    });
}

/**
 * Write to wsXMR token contract
 */
export async function writeWsxmr(functionName, args = []) {
    const client = getWalletClient();
    
    const { request } = await getPublicClient().simulateContract({
        address: CONTRACTS.wsxmrToken,
        abi: parsedABIs.wsxmr,
        functionName,
        args,
        account: userAddress
    });
    
    const hash = await client.writeContract({ ...request, account: userAddress });
    return waitMinedOrThrow(hash, functionName);
}

/**
 * Write to wsXMR token contract WITHOUT simulation — fallback when
 * RPC simulation fails with "internal error".
 */
export async function writeWsxmrUnsafe(functionName, args = [], gas = 200000n) {
    const client = getWalletClient();
    const account = getUserAddress();

    const { encodeFunctionData } = await import('https://esm.sh/viem@2.7.0');

    const data = encodeFunctionData({
        abi: parsedABIs.wsxmr,
        functionName,
        args,
    });

    const nonce = await getPublicClient().getTransactionCount({ address: account });

    const serializedTx = await client.signTransaction({
        account,
        chain: hyperevm,
        to: CONTRACTS.wsxmrToken,
        data,
        gas,
        gasPrice: 1000000000n,
        nonce,
    });

    const rpcUrls = NETWORKS.hyperevm.rpcUrls;
    let hash;
    let lastErr;
    for (const rpcUrl of rpcUrls) {
        try {
            console.log(`[writeWsxmrUnsafe] Trying RPC: ${rpcUrl}...`);
            const altClient = createPublicClient({
                chain: hyperevm,
                transport: http(rpcUrl, { retryCount: 1, timeout: 15000 })
            });
            hash = await altClient.sendRawTransaction({ serializedTransaction: serializedTx });
            console.log(`[writeWsxmrUnsafe] Accepted by ${rpcUrl}`);
            break;
        } catch (err) {
            console.warn(`[writeWsxmrUnsafe] RPC ${rpcUrl} failed:`, err.message);
            lastErr = err;
        }
    }
    if (!hash) throw lastErr;

    return waitMinedOrThrow(hash, functionName);
}

/**
 * Get user's wsXMR balance
 */
export async function getWsXmrBalance(address = null) {
    const targetAddress = address || userAddress;
    if (!targetAddress) {
        throw new Error('No address provided');
    }
    
    return await readWsxmr('balanceOf', [targetAddress]);
}

/**
 * Get user's native balance (HYPE)
 */
export async function getNativeBalance(address = null) {
    const targetAddress = address || userAddress;
    if (!targetAddress) {
        throw new Error('No address provided');
    }
    
    const client = getPublicClient();
    return await client.getBalance({ address: targetAddress });
}

/**
 * Watch for contract events
 */
export function watchContractEvent(contractAddress, abi, eventName, args = {}, callback, fromBlock = 'latest', onError = undefined) {
    const client = getPublicClient();

    return client.watchContractEvent({
        address: contractAddress,
        abi: parseAbi(abi),
        eventName,
        args,
        onLogs: callback,
        // Without onError, viem swallows poll failures (e.g. rate limits) and the
        // watcher silently never fires — always log so stalls are diagnosable.
        onError: onError || ((err) => console.warn(`[watchContractEvent:${eventName}] poll error:`, err?.message || err)),
        pollingInterval: 5000,
        fromBlock
    });
}

// HyperEVM RPCs cap eth_getLogs at ~1000-block ranges — chunk wide scans.
const LOG_QUERY_CHUNK = 900n;
const LOG_CHUNK_DELAY_MS = 120;

/**
 * getContractEvents with automatic block-range chunking.
 * Accepts the same params as client.getContractEvents; fromBlock/toBlock may be
 * bigint or 'latest'. Retries each chunk on rate-limit/RPC errors.
 */
export async function getContractEventsChunked(params) {
    const client = getPublicClient();
    const to = params.toBlock === 'latest' || params.toBlock === undefined
        ? await client.getBlockNumber()
        : BigInt(params.toBlock);
    const from = BigInt(params.fromBlock || 0n);
    const events = [];

    const queryRange = async (start, end, depth) => {
        let retries = 4;
        while (true) {
            try {
                return await client.getContractEvents({ ...params, fromBlock: start, toBlock: end });
            } catch (err) {
                const msg = err?.message || '';
                const details = err?.details || '';
                const isRangeError = msg.includes('block range') || details.includes('block range')
                    || msg.includes('exceeds max') || details.includes('exceeds max');
                // Some RPCs cap eth_getLogs below our chunk size — split the range.
                if (isRangeError && end - start > 50n && depth < 8) {
                    const mid = start + (end - start) / 2n;
                    const first = await queryRange(start, mid, depth + 1);
                    const second = await queryRange(mid + 1n, end, depth + 1);
                    return [...first, ...second];
                }
                const retryable = msg.includes('rate limit') || msg.includes('exceeds max block range')
                    || msg.includes('Failed to fetch') || msg.includes('fetch failed')
                    || err?.code === -32000 || err?.code === 429
                    || err?.name === 'RpcRequestError' || err?.name === 'InvalidParamsRpcError'
                    || err?.name === 'TypeError';
                if (!retryable || --retries === 0) throw err;
                await new Promise(r => setTimeout(r, 800));
            }
        }
    };

    for (let start = from; start <= to; start += LOG_QUERY_CHUNK) {
        const end = start + LOG_QUERY_CHUNK - 1n > to ? to : start + LOG_QUERY_CHUNK - 1n;
        events.push(...await queryRange(start, end, 0));
        await new Promise(r => setTimeout(r, LOG_CHUNK_DELAY_MS));
    }
    return events;
}

/**
 * eth_getLogs (raw, undecoded) with automatic block-range chunking.
 * Same chunk/retry discipline as getContractEventsChunked, but accepts raw
 * topics — lets a caller match MULTIPLE event signatures in one request
 * (topics[0] = [sigA, sigB, ...]) instead of one scan per event.
 * onChunk(logs, scannedTo) fires after each range so callers can persist
 * incremental progress and resume a timed-out scan.
 */
export async function getLogsChunked({ address, topics, fromBlock, toBlock = 'latest', onChunk = null }) {
    const client = getPublicClient();
    const to = toBlock === 'latest' || toBlock === undefined
        ? await client.getBlockNumber()
        : BigInt(toBlock);
    const from = BigInt(fromBlock || 0n);
    const logs = [];

    const queryLogs = async (start, end, depth) => {
        let retries = 4;
        while (true) {
            try {
                return await client.getLogs({ address, topics, fromBlock: start, toBlock: end });
            } catch (err) {
                const msg = err?.message || '';
                const details = err?.details || '';
                const isRangeError = msg.includes('block range') || details.includes('block range')
                    || msg.includes('exceeds max') || details.includes('exceeds max');
                if (isRangeError && end - start > 50n && depth < 8) {
                    const mid = start + (end - start) / 2n;
                    const first = await queryLogs(start, mid, depth + 1);
                    const second = await queryLogs(mid + 1n, end, depth + 1);
                    return [...first, ...second];
                }
                const retryable = msg.includes('rate limit') || msg.includes('exceeds max block range')
                    || msg.includes('Failed to fetch') || msg.includes('fetch failed')
                    || err?.code === -32000 || err?.code === 429
                    || err?.name === 'RpcRequestError' || err?.name === 'InvalidParamsRpcError'
                    || err?.name === 'TypeError';
                if (!retryable || --retries === 0) throw err;
                await new Promise(r => setTimeout(r, 800));
            }
        }
    };

    for (let start = from; start <= to; start += LOG_QUERY_CHUNK) {
        const end = start + LOG_QUERY_CHUNK - 1n > to ? to : start + LOG_QUERY_CHUNK - 1n;
        const chunk = await queryLogs(start, end, 0);
        logs.push(...chunk);
        if (onChunk) { try { onChunk(chunk, end); } catch {} }
        await new Promise(r => setTimeout(r, LOG_CHUNK_DELAY_MS));
    }
    return logs;
}

/**
 * Get past contract events (chunked — safe for ranges > 1000 blocks)
 */
export async function getPastEvents(contractAddress, abi, eventName, fromBlock, toBlock = 'latest', args = {}) {
    return await getContractEventsChunked({
        address: contractAddress,
        abi: Array.isArray(abi) && typeof abi[0] === 'string' ? parseAbi(abi) : abi,
        eventName,
        fromBlock,
        toBlock,
        args
    });
}

/**
 * Get current block number
 */
export async function getBlockNumber() {
    const client = getPublicClient();
    return await client.getBlockNumber();
}

/**
 * Listen for account changes
 */
export function onAccountsChanged(callback) {
    if (window.ethereum) {
        window.ethereum.on('accountsChanged', (accounts) => {
            if (accounts.length > 0) {
                userAddress = accounts[0];
                callback(accounts[0]);
            } else {
                userAddress = null;
                callback(null);
            }
        });
    }
}

/**
 * Listen for chain changes
 */
export function onChainChanged(callback) {
    if (window.ethereum) {
        window.ethereum.on('chainChanged', (chainId) => {
            callback(chainId);
        });
    }
}
