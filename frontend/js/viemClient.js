// Viem client setup for EVM interactions
// Uses createPublicClient and createWalletClient as required

import { createPublicClient, createWalletClient, custom, http, fallback, parseAbi } from 'https://esm.sh/viem@2.7.0';
import { gnosis } from 'https://esm.sh/viem@2.7.0/chains';
import { NETWORKS, CONTRACTS, ABIS, RAW_ABIS } from './config.js';

// Parse ABIs once at module level
// Append burn resolution functions that may be missing from cached config.js
const _extraHubAbi = parseAbi([
    'function abortBurn(bytes32 requestId) external',
    'function forceSettleBurn(bytes32 requestId) external',
    'function resolveDeclinedProposal(bytes32 requestId) external',
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
    const retryOpts = { retryCount: 2, retryDelay: 800 };
    const httpTransports = NETWORKS.gnosis.rpcUrls.map(url => http(url, retryOpts));
    // HTTP RPCs first for reads — MetaMask's internal RPC can be slow/unreliable on Gnosis.
    // MetaMask is still used for writes via walletClient.
    if (typeof window !== 'undefined' && window.ethereum) {
        return fallback([
            ...httpTransports,
            custom(window.ethereum, retryOpts)
        ], { rank: false, retryCount: 2 });
    }
    // Fallback to HTTP RPCs for users without a wallet
    return fallback(httpTransports, { rank: false, retryCount: 2 });
}

export async function initializeClients() {
    // Create public client with HTTP RPCs first, MetaMask as fallback
    publicClient = createPublicClient({
        chain: gnosis,
        transport: getTransport()
    });

    // Create wallet client using MetaMask if available
    if (typeof window.ethereum !== 'undefined') {
        walletClient = createWalletClient({
            chain: gnosis,
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
        chain: gnosis,
        transport: custom(window.ethereum)
    });

    // Ensure we're on the correct network
    await switchToGnosisChain();

    // Mark that the user has explicitly connected so we can auto-reconnect next visit
    localStorage.setItem('wrapsynth-wallet-connected', 'true');

    return address;
}

/**
 * Switch to Gnosis Chain if not already connected
 */
async function switchToGnosisChain() {
    try {
        await window.ethereum.request({
            method: 'wallet_switchEthereumChain',
            params: [{ chainId: '0x64' }], // 100 in hex
        });
    } catch (switchError) {
        // Chain not added, add it
        if (switchError.code === 4902) {
            await window.ethereum.request({
                method: 'wallet_addEthereumChain',
                params: [{
                    chainId: '0x64',
                    chainName: NETWORKS.gnosis.name,
                    nativeCurrency: NETWORKS.gnosis.nativeCurrency,
                    rpcUrls: NETWORKS.gnosis.rpcUrls,
                    blockExplorerUrls: [NETWORKS.gnosis.blockExplorer]
                }]
            });
        } else {
            throw switchError;
        }
    }
}

/**
 * Get current user address
 */
export function getUserAddress() {
    return userAddress;
}

/**
 * Ensure wallet is connected. Silently tries to get the current address
 * from MetaMask without prompting if already authorized.
 */
export async function ensureConnected() {
    if (userAddress) return userAddress;
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
                chain: gnosis,
                transport: custom(window.ethereum)
            });
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
export async function writeHub(functionName, args = [], value = 0n, gas = undefined) {
    const client = getWalletClient();

    const simOpts = {
        address: CONTRACTS.hub,
        abi: parsedABIs.hub,
        functionName,
        args,
        value,
        account: userAddress
    };
    if (gas !== undefined) {
        simOpts.gas = gas;
    }

    const { request } = await getPublicClient().simulateContract(simOpts);

    const hash = await client.writeContract({ ...request, account: userAddress });

    // Wait for transaction confirmation
    const receipt = await getPublicClient().waitForTransactionReceipt({ hash });

    return receipt;
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

    const hash = await client.writeContract({
        address: CONTRACTS.hub,
        abi: parsedABIs.hub,
        functionName,
        args,
        value,
        gas,
        account: userAddress
    });

    const receipt = await getPublicClient().waitForTransactionReceipt({ hash });
    return receipt;
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
    const receipt = await getPublicClient().waitForTransactionReceipt({ hash });
    
    return receipt;
}

/**
 * Write to wsXMR token contract WITHOUT simulation — fallback when
 * RPC simulation fails with "internal error".
 */
export async function writeWsxmrUnsafe(functionName, args = [], gas = 200000n) {
    const client = getWalletClient();

    const hash = await client.writeContract({
        address: CONTRACTS.wsxmrToken,
        abi: parsedABIs.wsxmr,
        functionName,
        args,
        gas,
        account: userAddress
    });

    const receipt = await getPublicClient().waitForTransactionReceipt({ hash });
    return receipt;
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
 * Get user's native balance (xDAI)
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
export function watchContractEvent(contractAddress, abi, eventName, args = {}, callback, fromBlock = 'latest') {
    const client = getPublicClient();
    
    return client.watchContractEvent({
        address: contractAddress,
        abi: parseAbi(abi),
        eventName,
        args,
        onLogs: callback,
        pollingInterval: 5000,
        fromBlock
    });
}

/**
 * Get past contract events
 */
export async function getPastEvents(contractAddress, abi, eventName, fromBlock, toBlock = 'latest', args = {}) {
    const client = getPublicClient();
    
    return await client.getContractEvents({
        address: contractAddress,
        abi: parseAbi(abi),
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
