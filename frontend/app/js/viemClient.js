// Viem client setup for EVM interactions
// Uses createPublicClient and createWalletClient as required

import { createPublicClient, createWalletClient, custom, http, parseAbi } from 'https://esm.sh/viem@2.7.0';
import { gnosis } from 'https://esm.sh/viem@2.7.0/chains';
import { NETWORKS, CONTRACTS, ABIS, RAW_ABIS } from './config.js';

// Parse ABIs once at module level
const parsedABIs = {
    hub: parseAbi(ABIS.hub),
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
export async function initializeClients() {
    // Create public client for reading data
    publicClient = createPublicClient({
        chain: gnosis,
        transport: http(NETWORKS.gnosis.rpcUrl)
    });

    // Check if MetaMask is available
    if (typeof window.ethereum === 'undefined') {
        throw new Error('MetaMask is not installed');
    }

    // Create wallet client using MetaMask
    walletClient = createWalletClient({
        chain: gnosis,
        transport: custom(window.ethereum)
    });

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

    // Ensure we're on the correct network
    await switchToGnosisChain();

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
                    rpcUrls: [NETWORKS.gnosis.rpcUrl],
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
    
    // Special handling for getVault which has tuple return type
    if (functionName === 'getVault') {
        return await client.readContract({
            address: CONTRACTS.hub,
            abi: [RAW_ABIS.getVault],
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
 */
export async function writeHub(functionName, args = [], value = 0n) {
    const client = getWalletClient();
    
    const { request } = await getPublicClient().simulateContract({
        address: CONTRACTS.hub,
        abi: parsedABIs.hub,
        functionName,
        args,
        value,
        account: userAddress
    });
    
    const hash = await client.writeContract(request);
    
    // Wait for transaction confirmation
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
    
    const hash = await client.writeContract(request);
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
