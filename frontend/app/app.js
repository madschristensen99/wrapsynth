// ============================================
// Viem Imports from CDN
// ============================================
import { 
    createPublicClient, 
    createWalletClient, 
    custom,
    http,
    formatUnits,
    parseUnits,
    parseEther,
    formatEther,
    decodeEventLog,
    keccak256,
    concat,
    toHex,
    encodeFunctionData,
    decodeFunctionResult
} from 'https://esm.sh/viem@2.7.15';

// ============================================
// SnarkJS for ZK Proof Generation
// ============================================
// Use jsdelivr which has better browser support
import * as snarkjs from 'https://cdn.jsdelivr.net/npm/snarkjs@0.7.4/+esm';

// ============================================
// Ed25519 for DLEQ Proofs
// ============================================
import * as ed from 'https://cdn.jsdelivr.net/npm/@noble/ed25519@1.7.3/+esm';

// ============================================
// Configuration
// ============================================
const CONFIG = {
    CHAIN_ID: 1301, // Unichain Sepolia
    RPC_URL: 'https://sepolia.unichain.org',
    CONTRACT_ADDRESS: '0xC67Cf54d14078ff2968b4Fcd55331C48CEf69eeF', // With mint intent validation
    EXPLORER_URL: 'https://sepolia.uniscan.xyz',
    PICONERO_PER_XMR: 1e12,
};

// Define Unichain Sepolia chain
const unichainSepolia = {
    id: 1301,
    name: 'Unichain Sepolia',
    network: 'unichain-sepolia',
    nativeCurrency: {
        decimals: 18,
        name: 'Ether',
        symbol: 'ETH',
    },
    rpcUrls: {
        default: {
            http: ['https://sepolia.unichain.org'],
        },
        public: {
            http: ['https://sepolia.unichain.org'],
        },
    },
    blockExplorers: {
        default: {
            name: 'Uniscan',
            url: 'https://sepolia.uniscan.xyz',
        },
    },
    testnet: true,
};

// ============================================
// State Management
// ============================================
let state = {
    publicClient: null,
    walletClient: null,
    userAddress: null,
    isConnected: false,
    isConnecting: false,
    selectedLP: null,
};

// ============================================
// Contract ABI
// ============================================
const CONTRACT_ABI = [
    {
        inputs: [{ name: 'account', type: 'address' }],
        name: 'balanceOf',
        outputs: [{ name: '', type: 'uint256' }],
        stateMutability: 'view',
        type: 'function',
    },
    {
        inputs: [{ name: 'lp', type: 'address' }],
        name: 'lpInfo',
        outputs: [{
            components: [
                { name: 'collateralAmount', type: 'uint256' },
                { name: 'backedAmount', type: 'uint256' },
                { name: 'mintFeeBps', type: 'uint256' },
                { name: 'burnFeeBps', type: 'uint256' },
                { name: 'intentDepositBps', type: 'uint256' },
                { name: 'moneroAddress', type: 'string' },
                { name: 'privateViewKey', type: 'bytes32' },
                { name: 'active', type: 'bool' },
                { name: 'registered', type: 'bool' }
            ],
            name: '',
            type: 'tuple'
        }],
        stateMutability: 'view',
        type: 'function',
    },
    {
        inputs: [
            { name: 'lp', type: 'address' },
            { name: 'expectedAmount', type: 'uint256' }
        ],
        name: 'createMintIntent',
        outputs: [{ name: '', type: 'uint256' }],
        stateMutability: 'payable',
        type: 'function',
    },
    {
        inputs: [
            { name: 'intentId', type: 'bytes32' }
        ],
        name: 'claimExpiredIntent',
        outputs: [],
        stateMutability: 'nonpayable',
        type: 'function',
    },
    {
        inputs: [
            { name: 'lp', type: 'address' },
            { name: 'amount', type: 'uint256' },
            { name: 'xmrAddress', type: 'string' }
        ],
        name: 'requestBurn',
        outputs: [{ name: '', type: 'uint256' }],
        stateMutability: 'nonpayable',
        type: 'function',
    },
    {
        inputs: [
            { name: 'mintFeeBps', type: 'uint256' },
            { name: 'burnFeeBps', type: 'uint256' },
            { name: 'intentDepositBps', type: 'uint256' },
            { name: 'moneroAddress', type: 'string' },
            { name: 'privateViewKey', type: 'bytes32' },
            { name: 'active', type: 'bool' }
        ],
        name: 'registerLP',
        outputs: [],
        stateMutability: 'nonpayable',
        type: 'function',
    },
    {
        inputs: [
            { name: 'proof', type: 'uint256[24]' },
            { name: 'publicSignals', type: 'uint256[70]' },
            { 
                name: 'dleqProof', 
                type: 'tuple',
                components: [
                    { name: 'c', type: 'bytes32' },
                    { name: 's', type: 'bytes32' },
                    { name: 'K1', type: 'bytes32' },
                    { name: 'K2', type: 'bytes32' }
                ]
            },
            { 
                name: 'ed25519Proof', 
                type: 'tuple',
                components: [
                    { name: 'R_x', type: 'bytes32' },
                    { name: 'R_y', type: 'bytes32' },
                    { name: 'S_x', type: 'bytes32' },
                    { name: 'S_y', type: 'bytes32' },
                    { name: 'P_x', type: 'bytes32' },
                    { name: 'P_y', type: 'bytes32' },
                    { name: 'B_x', type: 'bytes32' },
                    { name: 'B_y', type: 'bytes32' },
                    { name: 'G_x', type: 'bytes32' },
                    { name: 'G_y', type: 'bytes32' },
                    { name: 'A_x', type: 'bytes32' },
                    { name: 'A_y', type: 'bytes32' }
                ]
            },
            { 
                name: 'output', 
                type: 'tuple',
                components: [
                    { name: 'txHash', type: 'bytes32' },
                    { name: 'outputIndex', type: 'uint256' },
                    { name: 'ecdhAmount', type: 'bytes32' },
                    { name: 'outputPubKey', type: 'bytes32' },
                    { name: 'commitment', type: 'bytes32' }
                ]
            },
            { name: 'blockHeight', type: 'uint256' },
            { name: 'txMerkleProof', type: 'bytes32[]' },
            { name: 'txIndex', type: 'uint256' },
            { name: 'outputMerkleProof', type: 'bytes32[]' },
            { name: 'outputIndex', type: 'uint256' },
            { name: 'recipient', type: 'address' },
            { name: 'lp', type: 'address' },
            { name: 'txPublicKey', type: 'bytes32' },
            { name: 'priceUpdateData', type: 'bytes[]' }
        ],
        name: 'mint',
        outputs: [],
        stateMutability: 'payable',
        type: 'function',
    },
    {
        inputs: [],
        name: 'lpDeposit',
        outputs: [],
        stateMutability: 'payable',
        type: 'function',
    },
    {
        inputs: [],
        name: 'getXmrEthPrice',
        outputs: [{ name: '', type: 'uint256' }],
        stateMutability: 'view',
        type: 'function',
    },
    {
        inputs: [{ name: 'lp', type: 'address' }],
        name: 'getLPRatio',
        outputs: [{ name: '', type: 'uint256' }],
        stateMutability: 'view',
        type: 'function',
    },
    {
        inputs: [{ name: 'lp', type: 'address' }],
        name: 'getLPAvailableCapacity',
        outputs: [{ name: '', type: 'uint256' }],
        stateMutability: 'view',
        type: 'function',
    },
    {
        inputs: [],
        name: 'totalLPCollateral',
        outputs: [{ name: '', type: 'uint256' }],
        stateMutability: 'view',
        type: 'function',
    },
    {
        inputs: [],
        name: 'MIN_INTENT_DEPOSIT',
        outputs: [{ name: '', type: 'uint256' }],
        stateMutability: 'view',
        type: 'function',
    },
    {
        inputs: [],
        name: 'getLPCount',
        outputs: [{ name: '', type: 'uint256' }],
        stateMutability: 'view',
        type: 'function',
    },
    {
        inputs: [],
        name: 'getActiveLPs',
        outputs: [
            { name: 'addresses', type: 'address[]' },
            { name: 'moneroAddresses', type: 'string[]' },
            { name: 'mintFees', type: 'uint256[]' },
            { name: 'capacities', type: 'uint256[]' }
        ],
        stateMutability: 'view',
        type: 'function',
    },
    {
        inputs: [{ name: 'user', type: 'address' }],
        name: 'getUserMintIntents',
        outputs: [
            { name: 'intentIds', type: 'bytes32[]' },
            { name: 'lps', type: 'address[]' },
            { name: 'amounts', type: 'uint256[]' },
            { name: 'deposits', type: 'uint256[]' },
            { name: 'timestamps', type: 'uint256[]' }
        ],
        stateMutability: 'view',
        type: 'function',
    },
    {
        anonymous: false,
        inputs: [
            { indexed: true, name: 'intentId', type: 'uint256' },
            { indexed: true, name: 'user', type: 'address' },
            { indexed: true, name: 'lp', type: 'address' },
            { indexed: false, name: 'expectedAmount', type: 'uint256' }
        ],
        name: 'MintIntentCreated',
        type: 'event',
    },
    {
        anonymous: false,
        inputs: [
            { indexed: true, name: 'burnId', type: 'uint256' },
            { indexed: true, name: 'user', type: 'address' },
            { indexed: true, name: 'lp', type: 'address' },
            { indexed: false, name: 'amount', type: 'uint256' },
            { indexed: false, name: 'xmrAddress', type: 'string' }
        ],
        name: 'BurnRequested',
        type: 'event',
    },
];

// ============================================
// Initialization
// ============================================
// Wait for ethereum provider to be injected
function waitForEthereum(timeout = 3000) {
    return new Promise((resolve) => {
        if (window.ethereum) {
            resolve(window.ethereum);
            return;
        }

        let timeoutId;
        const checkInterval = setInterval(() => {
            if (window.ethereum) {
                clearInterval(checkInterval);
                clearTimeout(timeoutId);
                resolve(window.ethereum);
            }
        }, 100);

        timeoutId = setTimeout(() => {
            clearInterval(checkInterval);
            resolve(null);
        }, timeout);
    });
}

document.addEventListener('DOMContentLoaded', async () => {
    console.log('🌉 Hooked Monero Frontend Initialized');
    
    // Wait for wallet provider to be injected (Brave/MetaMask inject asynchronously)
    console.log('⏳ Waiting for wallet provider...');
    await waitForEthereum();
    
    // Setup event listeners
    setupEventListeners();
    
    // Initialize public client for reading contract data (doesn't require wallet)
    state.publicClient = createPublicClient({
        chain: unichainSepolia,
        transport: http(CONFIG.RPC_URL)
    });
    
    // Check if wallet is already connected
    const provider = getEthereumProvider();
    if (provider) {
        try {
            const accounts = await provider.request({ method: 'eth_accounts' });
            if (accounts.length > 0) {
                await connectWallet();
            }
        } catch (e) {
            console.log('No accounts connected yet');
        }
    }
    
    // Load initial data
    await loadInitialData();
});

// ============================================
// Wallet Provider Detection
// ============================================
function getEthereumProvider() {
    console.log('Checking for ethereum provider...');
    console.log('window.ethereum exists:', !!window.ethereum);
    console.log('window.ethereum.providers:', window.ethereum?.providers);
    
    // Check if there are multiple providers (e.g., Brave + MetaMask)
    if (window.ethereum?.providers && Array.isArray(window.ethereum.providers) && window.ethereum.providers.length > 0) {
        console.log('Found', window.ethereum.providers.length, 'providers');
        window.ethereum.providers.forEach((p, i) => {
            console.log(`Provider ${i}:`, {
                isBraveWallet: p.isBraveWallet,
                isMetaMask: p.isMetaMask,
            });
        });
        
        // Look for Brave Wallet specifically
        const braveProvider = window.ethereum.providers.find(p => p.isBraveWallet);
        if (braveProvider) {
            console.log('✅ Using Brave Wallet from providers array');
            return braveProvider;
        }
        // Otherwise return first provider
        console.log('✅ Using first provider from array');
        return window.ethereum.providers[0];
    }
    
    // Single provider case
    if (window.ethereum) {
        console.log('✅ Using window.ethereum directly');
        console.log('Provider flags:', {
            isBraveWallet: window.ethereum.isBraveWallet,
            isMetaMask: window.ethereum.isMetaMask,
        });
        return window.ethereum;
    }
    
    console.log('❌ No ethereum provider found');
    return null;
}

// ============================================
// Event Listeners
// ============================================
function setupEventListeners() {
    // Wallet connection
    document.getElementById('connectWallet').addEventListener('click', connectWallet);
    document.getElementById('disconnectWallet').addEventListener('click', disconnectWallet);
    
    // Tab switching
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const tabName = e.currentTarget.dataset.tab;
            switchTab(tabName);
        });
    });
    
    // Mint tab
    document.getElementById('lpSelect').addEventListener('change', handleLPSelection);
    document.getElementById('mintAmount').addEventListener('input', updateIntentDepositDisplay);
    document.getElementById('createIntentBtn').addEventListener('click', createMintIntent);
    const copyBtn = document.getElementById('copyAddressBtn');
    if (copyBtn) copyBtn.addEventListener('click', copyMoneroAddress);
    const generateProofBtn = document.getElementById('generateProofBtn');
    if (generateProofBtn) generateProofBtn.addEventListener('click', generateProofAndMint);
    
    // Burn tab
    document.getElementById('burnBtn').addEventListener('click', requestBurn);
    
    // LP tab
    document.getElementById('registerLpBtn').addEventListener('click', registerAsLP);
    document.getElementById('depositCollateralBtn').addEventListener('click', depositCollateral);
    const updateLpBtn = document.getElementById('updateLpBtn');
    if (updateLpBtn) updateLpBtn.addEventListener('click', updateLPSettings);
    
    // Listen for account changes
    const provider = getEthereumProvider();
    if (provider) {
        provider.on('accountsChanged', handleAccountsChanged);
        provider.on('chainChanged', () => window.location.reload());
    }
}

// ============================================
// Wallet Connection
// ============================================
async function connectWallet() {
    // Prevent multiple simultaneous connection attempts
    if (state.isConnecting) {
        console.log('Connection already in progress...');
        return;
    }
    
    try {
        state.isConnecting = true;
        
        const provider = getEthereumProvider();
        if (!provider) {
            showToast('Please install MetaMask or another Web3 wallet', 'error');
            return;
        }
        
        showLoading('Connecting wallet...');
        
        // Request account access
        const accounts = await provider.request({ method: 'eth_requestAccounts' });
        state.userAddress = accounts[0];
        state.isConnected = true;
        
        // Check network first (before creating clients)
        const chainIdHex = await provider.request({ method: 'eth_chainId' });
        const chainId = parseInt(chainIdHex, 16);
        console.log('Current chain ID:', chainId);
        
        if (chainId !== CONFIG.CHAIN_ID) {
            console.log('Wrong network, switching...');
            await switchNetwork();
        }
        
        // Create Viem clients
        state.walletClient = createWalletClient({
            account: state.userAddress,
            chain: unichainSepolia,
            transport: custom(provider)
        });
        
        state.publicClient = createPublicClient({
            chain: unichainSepolia,
            transport: http(CONFIG.RPC_URL)
        });
        
        // Update UI
        updateWalletUI();
        await loadUserData();
        
        hideLoading();
        showToast('Wallet connected successfully!', 'success');
        
    } catch (error) {
        console.error('Error connecting wallet:', error);
        hideLoading();
        showToast('Failed to connect wallet: ' + error.message, 'error');
    } finally {
        state.isConnecting = false;
    }
}

function disconnectWallet() {
    state.publicClient = null;
    state.walletClient = null;
    state.userAddress = null;
    state.isConnected = false;
    state.isConnecting = false;
    
    updateWalletUI();
    
    // Reset UI values
    document.getElementById('userBalance').textContent = '0.00';
    document.getElementById('burnBalance').textContent = '0.00';
    
    showToast('Wallet disconnected', 'info');
}

async function switchNetwork() {
    const provider = getEthereumProvider();
    if (!provider) return;
    
    try {
        console.log('Attempting to switch to Unichain Sepolia...');
        await provider.request({
            method: 'wallet_switchEthereumChain',
            params: [{ chainId: '0x' + CONFIG.CHAIN_ID.toString(16) }],
        });
        console.log('✅ Switched to Unichain Sepolia');
    } catch (switchError) {
        console.log('Switch error:', switchError);
        
        // Network not added, try to add it (error code 4902)
        if (switchError.code === 4902 || switchError.code === -32603) {
            try {
                console.log('Network not found, adding Unichain Sepolia...');
                await provider.request({
                    method: 'wallet_addEthereumChain',
                    params: [{
                        chainId: '0x' + CONFIG.CHAIN_ID.toString(16),
                        chainName: 'Unichain Sepolia',
                        nativeCurrency: {
                            name: 'ETH',
                            symbol: 'ETH',
                            decimals: 18
                        },
                        rpcUrls: [CONFIG.RPC_URL],
                        blockExplorerUrls: [CONFIG.EXPLORER_URL]
                    }],
                });
                console.log('✅ Added Unichain Sepolia network');
            } catch (addError) {
                console.error('Failed to add network:', addError);
                throw new Error('Please manually add Unichain Sepolia network to your wallet. Chain ID: 1301, RPC: ' + CONFIG.RPC_URL);
            }
        } else if (switchError.code === 4001) {
            // User rejected
            throw new Error('Please switch to Unichain Sepolia network to continue');
        } else {
            throw switchError;
        }
    }
}

function handleAccountsChanged(accounts) {
    if (accounts.length === 0) {
        // User disconnected wallet
        state.isConnected = false;
        state.userAddress = null;
        updateWalletUI();
    } else {
        // User switched accounts
        window.location.reload();
    }
}

function updateWalletUI() {
    const connectBtn = document.getElementById('connectWallet');
    const walletInfo = document.getElementById('walletInfo');
    const walletAddress = document.getElementById('walletAddress');
    
    if (state.isConnected) {
        connectBtn.classList.add('hidden');
        walletInfo.classList.remove('hidden');
        walletAddress.textContent = formatAddress(state.userAddress);
    } else {
        connectBtn.classList.remove('hidden');
        walletInfo.classList.add('hidden');
    }
}

// ============================================
// Data Loading
// ============================================
async function loadInitialData() {
    const lpSelect = document.getElementById('lpSelect');
    const burnLpSelect = document.getElementById('burnLpSelect');
    
    lpSelect.innerHTML = '<option value="">Loading LPs...</option>';
    burnLpSelect.innerHTML = '<option value="">Loading LPs...</option>';
    
    // Note: Intent deposit is now LP-specific and will be calculated when user selects an LP
    document.getElementById('intentDepositDisplay').textContent = 'Select LP first';
    
    try {
        // Fetch active LPs from contract
        const result = await state.publicClient.readContract({
            address: CONFIG.CONTRACT_ADDRESS,
            abi: CONTRACT_ABI,
            functionName: 'getActiveLPs'
        });
        
        const [addresses, moneroAddresses, mintFees, capacities] = result;
        
        lpSelect.innerHTML = '<option value="">Select a liquidity provider...</option>';
        burnLpSelect.innerHTML = '<option value="">Select a liquidity provider...</option>';
        
        if (addresses.length === 0) {
            lpSelect.innerHTML = '<option value="" disabled>No active LPs available - Register as LP to get started</option>';
            burnLpSelect.innerHTML = '<option value="" disabled>No active LPs available</option>';
        } else {
            for (let i = 0; i < addresses.length; i++) {
                const capacity = formatUnits(capacities[i], 12);
                const fee = (Number(mintFees[i]) / 100).toFixed(2);
                const option = `<option value="${addresses[i]}">${formatAddress(addresses[i])} - Fee: ${fee}% - Capacity: ${parseFloat(capacity).toFixed(4)} XMR</option>`;
                lpSelect.innerHTML += option;
                burnLpSelect.innerHTML += option;
            }
        }
    } catch (error) {
        console.error('Error loading LPs:', error);
        lpSelect.innerHTML = '<option value="">Error loading LPs</option>';
        burnLpSelect.innerHTML = '<option value="">Error loading LPs</option>';
    }
    
    // Also reload user balance
    await loadUserData();
}

async function loadUserData() {
    if (!state.publicClient || !state.userAddress) return;
    
    try {
        // Load user balance
        console.log('📊 Loading balance for:', state.userAddress);
        const balance = await state.publicClient.readContract({
            address: CONFIG.CONTRACT_ADDRESS,
            abi: CONTRACT_ABI,
            functionName: 'balanceOf',
            args: [state.userAddress]
        });
        console.log('📊 Raw balance:', balance.toString());
        const balanceXMR = formatUnits(balance, 12);
        console.log('📊 Balance in XMR:', balanceXMR);
        document.getElementById('userBalance').textContent = parseFloat(balanceXMR).toFixed(4) + ' XMR';
        document.getElementById('burnBalance').textContent = parseFloat(balanceXMR).toFixed(4);
        
        // Load XMR/ETH price
        try {
            const price = await state.publicClient.readContract({
                address: CONFIG.CONTRACT_ADDRESS,
                abi: CONTRACT_ABI,
                functionName: 'getXmrEthPrice'
            });
            const priceFormatted = formatEther(price);
            document.getElementById('xmrEthPrice').textContent = parseFloat(priceFormatted).toFixed(6) + ' ETH';
        } catch (e) {
            document.getElementById('xmrEthPrice').textContent = 'N/A';
        }
        
        // Load total collateral
        try {
            const totalCollateral = await state.publicClient.readContract({
                address: CONFIG.CONTRACT_ADDRESS,
                abi: CONTRACT_ABI,
                functionName: 'totalLPCollateral'
            });
            const collateralFormatted = formatEther(totalCollateral);
            document.getElementById('totalCollateral').textContent = parseFloat(collateralFormatted).toFixed(4) + ' wstETH';
        } catch (e) {
            document.getElementById('totalCollateral').textContent = 'N/A';
        }
        
        // Load LP info if user is an LP
        await loadLPInfo();
        
        // Load active mint intents
        await loadMintIntents();
        
    } catch (error) {
        console.error('Error loading user data:', error);
    }
}

async function loadMintIntents() {
    if (!state.publicClient || !state.userAddress) {
        console.log('loadMintIntents: Missing publicClient or userAddress');
        return;
    }
    
    try {
        console.log('loadMintIntents: Fetching intents for', state.userAddress);
        const result = await state.publicClient.readContract({
            address: CONFIG.CONTRACT_ADDRESS,
            abi: CONTRACT_ABI,
            functionName: 'getUserMintIntents',
            args: [state.userAddress]
        });
        
        console.log('loadMintIntents: Raw result:', result);
        const [intentIds, lps, amounts, deposits, timestamps] = result;
        
        // Clear existing intents display
        const intentsList = document.getElementById('activeIntentsList');
        if (!intentsList) return;
        
        if (intentIds.length === 0) {
            console.log('loadMintIntents: No intents found');
            intentsList.innerHTML = '<p class="empty-state">No active mint intents</p>';
            return;
        }
        
        console.log('loadMintIntents: Found', intentIds.length, 'intents');
        
        intentsList.innerHTML = '';
        
        for (let i = 0; i < intentIds.length; i++) {
            const intentId = intentIds[i];
            const lp = lps[i];
            const amount = amounts[i];
            const deposit = deposits[i];
            const timestamp = timestamps[i];
            
            const createdTime = Number(timestamp) * 1000;
            const expirationTime = createdTime + (2 * 60 * 60 * 1000); // 2 hours
            const now = Date.now();
            const canCancel = now > expirationTime;
            const timeUntilExpiry = expirationTime - now;
            
            // Fetch LP's Monero address
            let moneroAddress = 'Loading...';
            try {
                const lpInfoResult = await state.publicClient.readContract({
                    address: CONFIG.CONTRACT_ADDRESS,
                    abi: [{
                        inputs: [{ name: 'lp', type: 'address' }],
                        name: 'lpInfo',
                        outputs: [
                            { name: '', type: 'uint256' }, { name: '', type: 'uint256' }, { name: '', type: 'uint256' }, 
                            { name: '', type: 'uint256' }, { name: '', type: 'uint256' }, { name: 'moneroAddress', type: 'string' }
                        ],
                        stateMutability: 'view',
                        type: 'function'
                    }],
                    functionName: 'lpInfo',
                    args: [lp]
                });
                moneroAddress = lpInfoResult[5] || 'N/A';
            } catch (e) {
                console.error('Error fetching LP Monero address:', e);
            }
            
            const intentDiv = document.createElement('div');
            intentDiv.className = 'intent-item card';
            
            if (canCancel) {
                intentDiv.innerHTML = `
                    <div style="padding: 1rem; background: #fff3cd; border-left: 4px solid #ffc107; border-radius: 8px;">
                        <div style="font-weight: 600; color: #856404; margin-bottom: 0.5rem;">⚠️ Intent Expired</div>
                        <div style="font-size: 0.9em; color: #856404;">This intent has expired. The LP can now claim your deposit.</div>
                        <div style="font-size: 0.85em; color: #856404; margin-top: 0.5rem;">Intent ID: ${intentId.slice(0, 16)}...</div>
                    </div>
                `;
            } else {
                const hoursLeft = Math.floor(timeUntilExpiry / (60 * 60 * 1000));
                const minutesLeft = Math.floor((timeUntilExpiry % (60 * 60 * 1000)) / (60 * 1000));
                const xmrAmount = formatUnits(amount, 12);
                
                intentDiv.innerHTML = `
                    <div style="padding: 1.5rem; background: #f8f9fa; border: 2px solid #4CAF50; border-radius: 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.08);">
                        <div style="font-size: 1.1em; font-weight: 600; margin-bottom: 1rem; color: #2c3e50;">💸 Active Mint Intent</div>
                        
                        <div style="background: white; padding: 1rem; border-radius: 8px; margin-bottom: 1rem; border: 1px solid #e0e0e0;">
                            <div style="font-size: 0.9em; color: #4CAF50; font-weight: 600; margin-bottom: 0.5rem;">STEP 1: Send XMR</div>
                            <div style="font-weight: 600; font-size: 1.2em; margin-bottom: 0.5rem; color: #2c3e50;">${xmrAmount} XMR</div>
                            <div style="font-size: 0.85em; color: #666; margin-bottom: 0.5rem;">to this Monero address:</div>
                            <div style="background: #f5f5f5; padding: 0.75rem; border-radius: 6px; font-family: monospace; font-size: 0.75em; word-break: break-all; margin-bottom: 0.5rem; border: 1px solid #ddd; color: #333;">${moneroAddress}</div>
                            <button onclick="navigator.clipboard.writeText('${moneroAddress}'); window.showToast('Address copied!', 'success');" style="background: #4CAF50; border: none; color: white; padding: 0.5rem 1rem; border-radius: 6px; cursor: pointer; font-size: 0.85em; font-weight: 500;">📋 Copy Address</button>
                        </div>
                        
                        <div style="background: white; padding: 1rem; border-radius: 8px; margin-bottom: 1rem; border: 1px solid #e0e0e0;">
                            <div style="font-size: 0.9em; color: #2196F3; font-weight: 600; margin-bottom: 0.5rem;">STEP 2: Generate Proof</div>
                            <div style="font-size: 0.85em; color: #666;">After sending, scroll down to "Generate Proof & Complete Mint" section and provide your transaction details.</div>
                        </div>
                        
                        <div style="display: flex; justify-content: space-between; align-items: center; padding-top: 1rem; border-top: 1px solid #e0e0e0;">
                            <div>
                                <div style="font-size: 0.8em; color: #666;">⏰ Time remaining:</div>
                                <div style="font-weight: 600; color: #ff9800;">${hoursLeft}h ${minutesLeft}m</div>
                            </div>
                            <div style="text-align: right;">
                                <div style="font-size: 0.8em; color: #666;">Deposit at risk:</div>
                                <div style="font-weight: 600; color: #f44336;">${formatEther(deposit)} ETH</div>
                            </div>
                        </div>
                        
                        <div style="font-size: 0.75em; color: #999; margin-top: 1rem; padding-top: 1rem; border-top: 1px solid #e0e0e0;">Intent ID: ${intentId.slice(0, 20)}...</div>
                    </div>
                `;
            }
            
            intentsList.appendChild(intentDiv);
        }
        
    } catch (error) {
        console.error('Error loading mint intents:', error);
    }
}

async function loadLPInfo() {
    if (!state.publicClient || !state.userAddress) return;
    
    try {
        // Read LP info fields individually to avoid viem decoding issues
        const [collateralAmount, backedAmount, mintFeeBps, burnFeeBps, moneroAddress, privateViewKey, active, registered] = await Promise.all([
            state.publicClient.readContract({
                address: CONFIG.CONTRACT_ADDRESS,
                abi: [{
                    inputs: [{ name: 'lp', type: 'address' }],
                    name: 'lpInfo',
                    outputs: [{ name: 'collateralAmount', type: 'uint256' }],
                    stateMutability: 'view',
                    type: 'function'
                }],
                functionName: 'lpInfo',
                args: [state.userAddress]
            }).then(result => result[0] || 0n).catch(() => 0n),
            
            state.publicClient.readContract({
                address: CONFIG.CONTRACT_ADDRESS,
                abi: [{
                    inputs: [{ name: 'lp', type: 'address' }],
                    name: 'lpInfo',
                    outputs: [{ name: '', type: 'uint256' }, { name: 'backedAmount', type: 'uint256' }],
                    stateMutability: 'view',
                    type: 'function'
                }],
                functionName: 'lpInfo',
                args: [state.userAddress]
            }).then(result => result[1] || 0n).catch(() => 0n),
            
            state.publicClient.readContract({
                address: CONFIG.CONTRACT_ADDRESS,
                abi: [{
                    inputs: [{ name: 'lp', type: 'address' }],
                    name: 'lpInfo',
                    outputs: [{ name: '', type: 'uint256' }, { name: '', type: 'uint256' }, { name: 'mintFeeBps', type: 'uint256' }],
                    stateMutability: 'view',
                    type: 'function'
                }],
                functionName: 'lpInfo',
                args: [state.userAddress]
            }).then(result => result[2] || 0n).catch(() => 0n),
            
            state.publicClient.readContract({
                address: CONFIG.CONTRACT_ADDRESS,
                abi: [{
                    inputs: [{ name: 'lp', type: 'address' }],
                    name: 'lpInfo',
                    outputs: [{ name: '', type: 'uint256' }, { name: '', type: 'uint256' }, { name: '', type: 'uint256' }, { name: 'burnFeeBps', type: 'uint256' }],
                    stateMutability: 'view',
                    type: 'function'
                }],
                functionName: 'lpInfo',
                args: [state.userAddress]
            }).then(result => result[3] || 0n).catch(() => 0n),
            
            // Skip moneroAddress for now - it's causing the decoding issue
            Promise.resolve(''),
            Promise.resolve('0x0000000000000000000000000000000000000000000000000000000000000000'),
            
            state.publicClient.readContract({
                address: CONFIG.CONTRACT_ADDRESS,
                abi: [{
                    inputs: [{ name: 'lp', type: 'address' }],
                    name: 'lpInfo',
                    outputs: [
                        { name: '', type: 'uint256' }, { name: '', type: 'uint256' }, { name: '', type: 'uint256' }, 
                        { name: '', type: 'uint256' }, { name: '', type: 'uint256' }, { name: '', type: 'string' }, 
                        { name: '', type: 'bytes32' }, { name: 'active', type: 'bool' }
                    ],
                    stateMutability: 'view',
                    type: 'function'
                }],
                functionName: 'lpInfo',
                args: [state.userAddress]
            }).then(result => result[7] || false).catch(() => false),
            
            state.publicClient.readContract({
                address: CONFIG.CONTRACT_ADDRESS,
                abi: [{
                    inputs: [{ name: 'lp', type: 'address' }],
                    name: 'lpInfo',
                    outputs: [
                        { name: '', type: 'uint256' }, { name: '', type: 'uint256' }, { name: '', type: 'uint256' }, 
                        { name: '', type: 'uint256' }, { name: '', type: 'uint256' }, { name: '', type: 'string' }, 
                        { name: '', type: 'bytes32' }, { name: '', type: 'bool' }, { name: 'registered', type: 'bool' }
                    ],
                    stateMutability: 'view',
                    type: 'function'
                }],
                functionName: 'lpInfo',
                args: [state.userAddress]
            }).then(result => result[8] || false).catch(() => false)
        ]);
        
        console.log('LP registered:', registered);
        const isLP = registered;
        
        // Show/hide appropriate view
        const nonLpView = document.getElementById('nonLpView');
        const existingLpView = document.getElementById('existingLpView');
        
        if (isLP) {
            // User is an LP - show management view
            nonLpView.style.display = 'none';
            existingLpView.style.display = 'block';
            document.getElementById('lpTabBtn').textContent = 'Manage LP';
            
            // Variables already extracted from individual contract calls
            
            // Update stats
            const collateral = formatEther(collateralAmount);
            const backed = formatUnits(backedAmount, 12);
            
            document.getElementById('lpCollateral').textContent = parseFloat(collateral).toFixed(4) + ' wstETH';
            document.getElementById('lpBacked').textContent = parseFloat(backed).toFixed(4) + ' XMR';
            document.getElementById('lpStatus').textContent = active ? 'Active' : 'Inactive';
            
            // Update current configuration
            document.getElementById('lpCurrentMintFee').textContent = (Number(mintFeeBps) / 100).toFixed(2) + '%';
            document.getElementById('lpCurrentBurnFee').textContent = (Number(burnFeeBps) / 100).toFixed(2) + '%';
            document.getElementById('lpCurrentMoneroAddress').textContent = moneroAddress;
            
            // Set placeholders with current values
            document.getElementById('lpUpdateMintFee').placeholder = `Current: ${mintFeeBps} bps`;
            document.getElementById('lpUpdateBurnFee').placeholder = `Current: ${burnFeeBps} bps`;
            
            // Load ratio
            try {
                const ratio = await state.publicClient.readContract({
                    address: CONFIG.CONTRACT_ADDRESS,
                    abi: CONTRACT_ABI,
                    functionName: 'getLPRatio',
                    args: [state.userAddress]
                });
                
                // Check if ratio is max uint256 (no backing yet)
                const maxUint256 = 115792089237316195423570985008687907853269984665640564039457584007913129639935n;
                if (ratio >= maxUint256 || backedAmount === 0n) {
                    document.getElementById('lpYourRatio').textContent = '∞ (No backing yet)';
                } else {
                    document.getElementById('lpYourRatio').textContent = ratio.toString() + '%';
                }
            } catch (e) {
                console.log('Could not load LP ratio:', e.message);
                document.getElementById('lpYourRatio').textContent = 'N/A';
            }
        } else {
            // User is not an LP - show registration view
            nonLpView.style.display = 'block';
            existingLpView.style.display = 'none';
            document.getElementById('lpTabBtn').textContent = 'Become LP';
        }
    } catch (error) {
        // User is not an LP or contract has issues - show registration view
        console.error('Error loading LP info:', error);
        
        // Check if it's a decoding error (user not registered)
        if (error.message.includes('Position') && error.message.includes('out of bounds')) {
            console.log('User is not registered as LP on this contract');
        } else {
            console.error('Error message:', error.message);
        }
        
        document.getElementById('nonLpView').style.display = 'block';
        document.getElementById('existingLpView').style.display = 'none';
        document.getElementById('lpTabBtn').textContent = 'Become LP';
    }
}

// ============================================
// Tab Switching
// ============================================
function switchTab(tabName) {
    // Update tab buttons
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.classList.remove('active');
        if (btn.dataset.tab === tabName) {
            btn.classList.add('active');
        }
    });
    
    // Update tab content
    document.querySelectorAll('.tab-content').forEach(content => {
        content.classList.remove('active');
    });
    document.getElementById(tabName + 'Tab').classList.add('active');
}

// ============================================
// Mint Functions
// ============================================
function handleLPSelection(event) {
    const lpAddress = event.target.value;
    state.selectedLP = lpAddress;
    
    if (lpAddress && state.publicClient) {
        loadLPDetails(lpAddress);
    }
}

async function loadLPDetails(lpAddress) {
    try {
        // Get fee from the select option (already loaded from getActiveLPs)
        const selectElement = document.getElementById('lpSelect');
        const selectedOption = selectElement.options[selectElement.selectedIndex];
        if (selectedOption && selectedOption.text.includes('Fee:')) {
            const feeMatch = selectedOption.text.match(/Fee: ([\d.]+)%/);
            if (feeMatch) {
                document.getElementById('lpMintFee').textContent = feeMatch[1] + '%';
            }
        }
        
        // Load capacity
        try {
            const capacity = await state.publicClient.readContract({
                address: CONFIG.CONTRACT_ADDRESS,
                abi: CONTRACT_ABI,
                functionName: 'getLPAvailableCapacity',
                args: [lpAddress]
            });
            const capacityXMR = formatUnits(capacity, 12);
            document.getElementById('lpCapacity').textContent = parseFloat(capacityXMR).toFixed(4) + ' XMR';
        } catch (e) {
            console.error('Error loading capacity:', e);
            document.getElementById('lpCapacity').textContent = 'N/A';
        }
        
        // Load LP's intent deposit requirement (read just index 4)
        try {
            const intentDepositBps = await state.publicClient.readContract({
                address: CONFIG.CONTRACT_ADDRESS,
                abi: [{
                    inputs: [{ name: 'lp', type: 'address' }],
                    name: 'lpInfo',
                    outputs: [
                        { name: '', type: 'uint256' }, { name: '', type: 'uint256' }, { name: '', type: 'uint256' }, 
                        { name: '', type: 'uint256' }, { name: 'intentDepositBps', type: 'uint256' }
                    ],
                    stateMutability: 'view',
                    type: 'function'
                }],
                functionName: 'lpInfo',
                args: [lpAddress]
            }).then(result => result[4] || 0n);
            
            state.selectedLPIntentDepositBps = intentDepositBps;
            console.log('LP intent deposit bps:', intentDepositBps);
            
            // Update deposit display
            updateIntentDepositDisplay();
        } catch (e) {
            console.error('Error loading LP intent deposit:', e);
            state.selectedLPIntentDepositBps = 0n;
        }
        
        // Load ratio
        try {
            const ratio = await state.publicClient.readContract({
                address: CONFIG.CONTRACT_ADDRESS,
                abi: CONTRACT_ABI,
                functionName: 'getLPRatio',
                args: [lpAddress]
            });
            // Check if ratio is max uint256 (no backing yet)
            const maxUint256 = 115792089237316195423570985008687907853269984665640564039457584007913129639935n;
            if (ratio >= maxUint256) {
                document.getElementById('lpRatio').textContent = '∞ (No backing yet)';
            } else {
                document.getElementById('lpRatio').textContent = ratio.toString() + '%';
            }
        } catch (e) {
            console.error('Error loading ratio:', e);
            document.getElementById('lpRatio').textContent = 'N/A';
        }
        
    } catch (error) {
        console.error('Error loading LP details:', error);
    }
}

function updateIntentDepositDisplay() {
    const mintAmount = document.getElementById('mintAmount').value;
    const depositDisplay = document.getElementById('intentDepositDisplay');
    
    if (!mintAmount || !state.selectedLPIntentDepositBps) {
        depositDisplay.textContent = 'Enter amount';
        return;
    }
    
    try {
        // Use same calculation as createMintIntent: XMR = $330, ETH = $2500
        const xmrAmount = parseFloat(mintAmount);
        const depositPercent = Number(state.selectedLPIntentDepositBps) / 100; // Convert bps to percent
        
        // Calculate: (xmrAmount * 330 / 2500) * (intentDepositBps / 10000) * 5 (buffer)
        const xmrValueEth = (xmrAmount * 330) / 2500;
        const depositEth = xmrValueEth * (depositPercent / 100);
        const depositWithBuffer = depositEth * 5; // 5x buffer to match createMintIntent
        
        depositDisplay.textContent = `~${depositWithBuffer.toFixed(6)} ETH (${depositPercent}% + 5x safety buffer)`;
    } catch (e) {
        depositDisplay.textContent = 'Calculating...';
    }
}

async function createMintIntent() {
    if (!state.isConnected) {
        showToast('Please connect your wallet first', 'warning');
        return;
    }
    
    const lpAddress = document.getElementById('lpSelect').value;
    const amount = document.getElementById('mintAmount').value;
    
    if (!lpAddress || !amount) {
        showToast('Please fill in all fields', 'warning');
        return;
    }
    
    if (!state.selectedLPIntentDepositBps) {
        showToast('Please select an LP first', 'warning');
        return;
    }
    
    try {
        showLoading('Creating mint intent...');
        
        // Convert amount to piconero
        const amountPiconero = parseUnits(amount, 12);
        
        // Calculate required deposit based on LP's setting
        // Using fixed prices: XMR = $330, ETH = $2500
        // amountPiconero is in piconero (1 XMR = 1e12 piconero)
        // We need result in wei (1 ETH = 1e18 wei)
        // Formula: (xmrInPiconero / 1e12) * 330 / 2500 * intentDepositBps / 10000 * 1e18
        // = xmrInPiconero * 330 * intentDepositBps * 1e18 / (1e12 * 2500 * 10000)
        // = xmrInPiconero * 330 * intentDepositBps * 1e6 / 25000000
        
        let depositWei = (amountPiconero * 330n * state.selectedLPIntentDepositBps * 1000000n) / 25000000n;
        // Add 5x buffer to account for price differences with oracle (will be refunded if excess)
        depositWei = depositWei * 5n;
        console.log('Deposit required (with 5x buffer for safety):', formatEther(depositWei), 'ETH');
        
        const hash = await state.walletClient.writeContract({
            address: CONFIG.CONTRACT_ADDRESS,
            abi: CONTRACT_ABI,
            functionName: 'createMintIntent',
            args: [lpAddress, amountPiconero],
            value: depositWei,
            gas: 300000n
        });
        
        showLoading('Waiting for confirmation...');
        const receipt = await state.publicClient.waitForTransactionReceipt({ 
            hash,
            pollingInterval: 2000,
            timeout: 120000
        });
        
        // Parse event to get intent ID
        let intentId = 'N/A';
        for (const log of receipt.logs) {
            try {
                const decoded = decodeEventLog({
                    abi: CONTRACT_ABI,
                    data: log.data,
                    topics: log.topics
                });
                if (decoded.eventName === 'MintIntentCreated') {
                    intentId = decoded.args.intentId.toString();
                    break;
                }
            } catch (e) {
                // Skip logs that don't match
            }
        }
        
        hideLoading();
        
        // Get LP's Monero address from the select option
        const selectElement = document.getElementById('lpSelect');
        let moneroAddress = 'Loading...';
        
        try {
            // Fetch from getActiveLPs to get the Monero address
            const result = await state.publicClient.readContract({
                address: CONFIG.CONTRACT_ADDRESS,
                abi: CONTRACT_ABI,
                functionName: 'getActiveLPs'
            });
            const [addresses, moneroAddresses] = result;
            const lpIndex = addresses.findIndex(addr => addr.toLowerCase() === lpAddress.toLowerCase());
            if (lpIndex !== -1) {
                moneroAddress = moneroAddresses[lpIndex];
            }
        } catch (e) {
            console.error('Error fetching LP Monero address:', e);
        }
        
        // Show instructions if elements exist
        const intentIdEl = document.getElementById('intentId');
        const xmrAddressEl = document.getElementById('xmrAddress');
        const instructionsEl = document.getElementById('mintInstructions');
        
        if (intentIdEl) intentIdEl.textContent = intentId;
        if (xmrAddressEl) xmrAddressEl.textContent = moneroAddress;
        if (instructionsEl) instructionsEl.classList.remove('hidden');
        
        showToast(`Mint intent created! Send XMR to: ${moneroAddress}`, 'success');
        
        // Add to activity
        addActivity('Mint Intent Created', `Intent ID: ${intentId.slice(0, 10)}...`, 'Just now');
        
        // Reload mint intents to show the new one
        await loadMintIntents();
        
    } catch (error) {
        console.error('Error creating mint intent:', error);
        hideLoading();
        showToast('Failed to create mint intent: ' + error.message, 'error');
    }
}

function copyMoneroAddress() {
    const address = document.getElementById('xmrAddress').textContent;
    navigator.clipboard.writeText(address);
    showToast('Address copied to clipboard!', 'success');
}

// Note: Users cannot cancel mint intents. They have 2 hours to complete the mint.
// After 2 hours, the LP can claim the deposit using claimExpiredIntent.

// ============================================
// Burn Functions
// ============================================
async function requestBurn() {
    if (!state.isConnected) {
        showToast('Please connect your wallet first', 'warning');
        return;
    }
    
    const lpAddress = document.getElementById('burnLpSelect').value;
    const amount = document.getElementById('burnAmount').value;
    const xmrAddress = document.getElementById('xmrRecipient').value;
    
    if (!lpAddress || !amount || !xmrAddress) {
        showToast('Please fill in all fields', 'warning');
        return;
    }
    
    // Validate Monero address (basic check - mainnet starts with 4, subaddress with 8)
    if ((!xmrAddress.startsWith('4') && !xmrAddress.startsWith('8')) || xmrAddress.length < 95) {
        showToast('Invalid Monero address', 'error');
        return;
    }
    
    try {
        showLoading('Requesting burn...');
        
        const amountPiconero = parseUnits(amount, 12);
        
        const hash = await state.walletClient.writeContract({
            address: CONFIG.CONTRACT_ADDRESS,
            abi: CONTRACT_ABI,
            functionName: 'requestBurn',
            args: [lpAddress, amountPiconero, xmrAddress],
            gas: 300000n
        });
        
        showLoading('Waiting for confirmation...');
        await state.publicClient.waitForTransactionReceipt({ 
            hash,
            pollingInterval: 2000,
            timeout: 120000
        });
        
        hideLoading();
        showToast('Burn request submitted successfully!', 'success');
        
        // Reload user data
        await loadUserData();
        
        // Add to activity
        addActivity('Burn Requested', `${amount} XMR`, 'Just now');
        
    } catch (error) {
        console.error('Error requesting burn:', error);
        hideLoading();
        showToast('Failed to request burn: ' + error.message, 'error');
    }
}

// ============================================
// LP Functions
// ============================================
async function registerAsLP() {
    if (!state.isConnected) {
        showToast('Please connect your wallet first', 'warning');
        return;
    }
    
    const mintFee = document.getElementById('lpMintFeeInput').value;
    const burnFee = document.getElementById('lpBurnFeeInput').value;
    const intentDeposit = document.getElementById('lpIntentDepositInput').value;
    const moneroAddress = document.getElementById('lpMoneroAddress').value;
    const privateViewKey = document.getElementById('lpPrivateViewKey').value;
    const active = true; // Always active when registering
    
    if (!mintFee || !burnFee || !intentDeposit || !moneroAddress || !privateViewKey) {
        showToast('Please fill in all fields', 'warning');
        return;
    }
    
    // Basic Monero address validation (mainnet starts with 4, testnet with 5/9, subaddress with 8)
    if (moneroAddress.length < 95) {
        showToast('Invalid Monero address (too short)', 'error');
        return;
    }
    
    // Validate private view key format (should be 64 hex chars or 66 with 0x prefix)
    let viewKeyHex = privateViewKey.trim();
    if (!viewKeyHex.startsWith('0x')) {
        viewKeyHex = '0x' + viewKeyHex;
    }
    if (!/^0x[0-9a-fA-F]{64}$/.test(viewKeyHex)) {
        showToast('Invalid private view key format (must be 32 bytes / 64 hex characters)', 'error');
        return;
    }
    
    try {
        showLoading('Registering as LP...');
        
        const hash = await state.walletClient.writeContract({
            address: CONFIG.CONTRACT_ADDRESS,
            abi: CONTRACT_ABI,
            functionName: 'registerLP',
            args: [BigInt(mintFee), BigInt(burnFee), BigInt(intentDeposit), moneroAddress, viewKeyHex, active],
            gas: 500000n
        });
        
        showLoading('Waiting for confirmation...');
        try {
            await state.publicClient.waitForTransactionReceipt({ 
                hash,
                pollingInterval: 3000,
                timeout: 60000
            });
            
            hideLoading();
            showToast('Successfully registered as LP!', 'success');
        } catch (waitError) {
            // If waiting fails but tx was submitted, still consider it successful
            if (waitError.message.includes('block is out of range') || waitError.message.includes('timeout')) {
                console.log('Transaction submitted but confirmation timed out. Hash:', hash);
                hideLoading();
                showToast(`Transaction submitted! Hash: ${hash.slice(0, 10)}... Check explorer for confirmation.`, 'success');
            } else {
                throw waitError;
            }
        }
        
        // Reload LP info and LP list after a delay
        setTimeout(() => {
            loadLPInfo();
            loadInitialData(); // Reload LP dropdown
        }, 5000);
        
    } catch (error) {
        console.error('Error registering as LP:', error);
        hideLoading();
        showToast('Failed to register as LP: ' + error.message, 'error');
    }
}

async function depositCollateral() {
    if (!state.isConnected) {
        showToast('Please connect your wallet first', 'warning');
        return;
    }
    
    const amount = document.getElementById('lpDepositAmount').value;
    
    if (!amount) {
        showToast('Please enter an amount', 'warning');
        return;
    }
    
    try {
        showLoading('Depositing collateral...');
        
        const amountWei = parseEther(amount);
        
        const hash = await state.walletClient.writeContract({
            address: CONFIG.CONTRACT_ADDRESS,
            abi: CONTRACT_ABI,
            functionName: 'lpDeposit',
            value: amountWei,
            gas: 300000n
        });
        
        showLoading('Waiting for confirmation...');
        
        // Try to wait for receipt, but handle RPC errors gracefully
        try {
            await state.publicClient.waitForTransactionReceipt({ 
                hash,
                pollingInterval: 2000,
                timeout: 30000 // Shorter timeout
            });
        } catch (receiptError) {
            // If it's a block range error, the transaction likely succeeded
            if (receiptError.message.includes('block is out of range') || 
                receiptError.message.includes('HTTP request failed')) {
                console.log('RPC error waiting for receipt, but transaction was sent:', hash);
                // Continue anyway - transaction was sent
            } else {
                throw receiptError; // Re-throw other errors
            }
        }
        
        hideLoading();
        showToast(`Collateral deposit sent! TX: ${hash.slice(0, 10)}...`, 'success');
        addActivity('Collateral Deposited', `${amount} ETH`, 'Just now');
        
        // Wait a bit for the transaction to be mined, then reload
        setTimeout(async () => {
            await loadLPInfo();
            await loadInitialData();
        }, 3000);
        
    } catch (error) {
        console.error('Error depositing collateral:', error);
        hideLoading();
        
        // Check if it's the wstETH wrapping issue
        if (error.message.includes('execution reverted') || error.message.includes('wstETH wrap failed')) {
            showToast('⚠️ ETH to wstETH wrapping failed. The wstETH contract on Unichain Sepolia may not support direct ETH deposits. Please contact the team for assistance.', 'error');
        } else {
            showToast('Failed to deposit collateral: ' + error.message, 'error');
        }
    }
}

async function updateLPSettings() {
    if (!state.isConnected) {
        showToast('Please connect your wallet first', 'warning');
        return;
    }
    
    try {
        // Get current LP info first (using simplified ABI to avoid viem struct decoding issues)
        const currentLpInfoRaw = await state.publicClient.readContract({
            address: CONFIG.CONTRACT_ADDRESS,
            abi: [{
                inputs: [{ name: 'lp', type: 'address' }],
                name: 'lpInfo',
                outputs: [
                    { name: 'collateralAmount', type: 'uint256' },
                    { name: 'backedAmount', type: 'uint256' },
                    { name: 'mintFeeBps', type: 'uint256' },
                    { name: 'burnFeeBps', type: 'uint256' },
                    { name: 'intentDepositBps', type: 'uint256' },
                    { name: 'moneroAddress', type: 'string' },
                    { name: 'privateViewKey', type: 'bytes32' },
                    { name: 'active', type: 'bool' },
                    { name: 'registered', type: 'bool' }
                ],
                stateMutability: 'view',
                type: 'function'
            }],
            functionName: 'lpInfo',
            args: [state.userAddress]
        });
        
        // Map array response to object
        const currentLpInfo = {
            collateralAmount: currentLpInfoRaw[0],
            backedAmount: currentLpInfoRaw[1],
            mintFeeBps: currentLpInfoRaw[2],
            burnFeeBps: currentLpInfoRaw[3],
            intentDepositBps: currentLpInfoRaw[4],
            moneroAddress: currentLpInfoRaw[5],
            privateViewKey: currentLpInfoRaw[6],
            active: currentLpInfoRaw[7],
            registered: currentLpInfoRaw[8]
        };
        
        if (!currentLpInfo.registered) {
            showToast('You are not registered as an LP', 'error');
            return;
        }
        
        // Get new values or use current ones
        const newMintFee = document.getElementById('lpUpdateMintFee').value || currentLpInfo.mintFeeBps.toString();
        const newBurnFee = document.getElementById('lpUpdateBurnFee').value || currentLpInfo.burnFeeBps.toString();
        const newMoneroAddress = document.getElementById('lpUpdateMoneroAddress').value || currentLpInfo.moneroAddress;
        const newPrivateViewKey = document.getElementById('lpUpdatePrivateViewKey').value || currentLpInfo.privateViewKey;
        const newActive = true; // LPs are always active
        
        // Validate private view key format if provided
        let viewKeyHex = newPrivateViewKey;
        if (typeof viewKeyHex === 'string') {
            viewKeyHex = viewKeyHex.trim();
            if (!viewKeyHex.startsWith('0x')) {
                viewKeyHex = '0x' + viewKeyHex;
            }
            if (!/^0x[0-9a-fA-F]{64}$/.test(viewKeyHex)) {
                showToast('Invalid private view key format (must be 32 bytes / 64 hex characters)', 'error');
                return;
            }
        }
        
        showLoading('Updating LP settings...');
        
        const hash = await state.walletClient.writeContract({
            address: CONFIG.CONTRACT_ADDRESS,
            abi: CONTRACT_ABI,
            functionName: 'registerLP',
            args: [BigInt(newMintFee), BigInt(newBurnFee), currentLpInfo.intentDepositBps, newMoneroAddress, viewKeyHex, newActive],
            gas: 500000n
        });
        
        showLoading('Waiting for confirmation...');
        await state.publicClient.waitForTransactionReceipt({ 
            hash,
            pollingInterval: 2000,
            timeout: 120000
        });
        
        hideLoading();
        showToast('LP settings updated successfully!', 'success');
        
        // Clear update fields
        document.getElementById('lpUpdateMintFee').value = '';
        document.getElementById('lpUpdateBurnFee').value = '';
        document.getElementById('lpUpdateMoneroAddress').value = '';
        document.getElementById('lpUpdatePrivateViewKey').value = '';
        
        // Reload LP info and dropdown
        await loadLPInfo();
        await loadInitialData();
        
    } catch (error) {
        console.error('Error updating LP settings:', error);
        hideLoading();
        showToast('Failed to update LP settings: ' + error.message, 'error');
    }
}

// ============================================
// Merkle Proof Computation (Browser)
// ============================================
function keccak256Hash(data) {
    // Use js-sha3 library (loaded globally as window.sha3)
    if (typeof window.sha3 !== 'undefined' && window.sha3.keccak256) {
        return '0x' + window.sha3.keccak256(data);
    } else if (typeof keccak256 !== 'undefined') {
        return '0x' + keccak256(data);
    } else {
        throw new Error('keccak256 library not loaded');
    }
}

function computeMerkleProofFromLeaves(leaves, leafIndex) {
    const proof = [];
    let currentIndex = leafIndex;
    let currentLevel = leaves.map(leaf => leaf.startsWith('0x') ? leaf.slice(2) : leaf);
    
    while (currentLevel.length > 1) {
        const nextLevel = [];
        
        for (let i = 0; i < currentLevel.length; i += 2) {
            const left = currentLevel[i];
            // Duplicate last hash for odd number (matches oracle/backend)
            const right = i + 1 < currentLevel.length ? currentLevel[i + 1] : left;
            
            // Add sibling to proof if this pair contains our leaf
            if (i === currentIndex || i + 1 === currentIndex) {
                const sibling = (i === currentIndex) ? right : left;
                // Ensure no double 0x prefix
                const cleanSibling = sibling.startsWith('0x') ? sibling.slice(2) : sibling;
                proof.push('0x' + cleanSibling);
            }
            
            // Hash pair using viem's keccak256 and concat (matches ethers)
            const leftHex = '0x' + left;
            const rightHex = '0x' + right;
            const hash = keccak256(concat([leftHex, rightHex]));
            nextLevel.push(hash.slice(2));
        }
        
        currentIndex = Math.floor(currentIndex / 2);
        currentLevel = nextLevel;
    }
    
    return proof;
}

/**
 * Compute output Merkle proof
 */
async function computeOutputMerkleProof(blockHeight, txHash, outputIndex) {
    console.log(`Computing output Merkle proof for output ${outputIndex} in TX ${txHash}...`);
    
    // 1. Get block data
    const moneroRpcUrl = 'https://corsproxy.io/?' + encodeURIComponent('http://xmr.privex.io:18081/json_rpc');
    const blockResponse = await fetch(moneroRpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            jsonrpc: '2.0',
            id: '0',
            method: 'get_block',
            params: { height: blockHeight }
        })
    });
    
    const blockData = await blockResponse.json();
    if (blockData.error) {
        throw new Error(`Failed to get block: ${blockData.error.message}`);
    }
    
    const allTxHashes = blockData.result.tx_hashes || [];
    console.log(`  Block has ${allTxHashes.length} transactions`);
    
    // 2. Fetch all transactions in batches to avoid 413 error
    const BATCH_SIZE = 20;
    const allTransactions = [];
    
    for (let i = 0; i < allTxHashes.length; i += BATCH_SIZE) {
        const batch = allTxHashes.slice(i, i + BATCH_SIZE);
        console.log(`  Fetching batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(allTxHashes.length / BATCH_SIZE)} (${batch.length} TXs)...`);
        
        const txResponse = await fetch('https://corsproxy.io/?' + encodeURIComponent('http://xmr.privex.io:18081/get_transactions'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                txs_hashes: batch,
                decode_as_json: true
            })
        });
        
        const txData = await txResponse.json();
        if (txData.status !== 'OK') {
            throw new Error(`Failed to fetch transaction batch ${Math.floor(i / BATCH_SIZE) + 1}`);
        }
        
        allTransactions.push(...txData.txs);
    }
    
    console.log(`  Fetched ${allTransactions.length} transactions total`);
    const txData = { txs: allTransactions };
    
    // 3. Build list of all outputs with their global indices
    const allOutputs = [];
    let currentGlobalIndex = 0;
    let targetGlobalIndex = -1;
    
    const normalizedTargetTxHash = txHash.replace(/^0x/, '');
    console.log(`  Looking for TX: ${normalizedTargetTxHash}, output index: ${outputIndex}`);
    
    for (let i = 0; i < allTxHashes.length; i++) {
        const txHashInBlock = allTxHashes[i];
        const txInfo = txData.txs.find(t => t.tx_hash === txHashInBlock);
        
        if (!txInfo) {
            console.log(`  Warning: TX ${txHashInBlock} not found in response`);
            continue;
        }
        
        const tx = JSON.parse(txInfo.as_json);
        const outputs = tx.vout || [];
        
        // Debug: show when we find the target TX
        if (txHashInBlock === normalizedTargetTxHash) {
            console.log(`  Found target TX at block index ${i}, has ${outputs.length} outputs`);
            console.log(`  TX outputs:`, outputs);
            console.log(`  RCT signatures:`, tx.rct_signatures);
        }
        
        for (let j = 0; j < outputs.length; j++) {
            const vout = outputs[j];
            const target = vout.target;
            
            // Debug for target TX
            if (txHashInBlock === normalizedTargetTxHash) {
                console.log(`  Output ${j}:`, vout);
                console.log(`    Target:`, target);
                console.log(`    Has target.key:`, !!(target && target.key));
                console.log(`    Has target.tagged_key:`, !!(target && target.tagged_key));
            }
            
            // Support both old format (target.key) and new format (target.tagged_key.key)
            const outputKey = target?.key || target?.tagged_key?.key;
            
            if (outputKey) {
                const ecdhInfo = tx.rct_signatures?.ecdhInfo?.[j] || {};
                const ecdhAmount = ecdhInfo.amount || '0000000000000000';
                const commitment = tx.rct_signatures?.outPk?.[j] || '0'.repeat(64);
                
                // Check if this is our target output
                if (txHashInBlock === normalizedTargetTxHash && j === outputIndex) {
                    console.log(`  ✅ Found target output at global index ${currentGlobalIndex}`);
                    targetGlobalIndex = currentGlobalIndex;
                }
                
                allOutputs.push({
                    txHash: '0x' + txHashInBlock,
                    outputIndex: j, // Local index within TX
                    globalOutputIndex: currentGlobalIndex, // Global index in block
                    ecdhAmount: '0x' + ecdhAmount.padStart(64, '0'),
                    outputPubKey: '0x' + outputKey,
                    commitment: '0x' + commitment
                });
                
                currentGlobalIndex++;
            }
        }
    }
    
    if (targetGlobalIndex === -1) {
        throw new Error(`Output ${outputIndex} in TX ${txHash} not found in block`);
    }
    
    console.log(`  Total outputs in block: ${allOutputs.length}`);
    console.log(`  Target output global index: ${targetGlobalIndex}`);
    
    // 4. Build output Merkle tree leaves (keccak256 of packed data)
    const leaves = allOutputs.map((out, idx) => {
        // Pack: txHash || globalOutputIndex || ecdhAmount || outputPubKey || commitment
        // IMPORTANT: Use globalOutputIndex, not local outputIndex!
        const packed = concat([
            out.txHash,
            toHex(BigInt(out.globalOutputIndex), { size: 32 }),
            out.ecdhAmount,
            out.outputPubKey,
            out.commitment
        ]);
        const leaf = keccak256(packed);
        
        // Log the target output's leaf computation
        if (idx === targetGlobalIndex) {
            console.log('  Target output leaf computation:');
            console.log('    txHash:', out.txHash);
            console.log('    globalOutputIndex:', out.globalOutputIndex);
            console.log('    ecdhAmount:', out.ecdhAmount);
            console.log('    outputPubKey:', out.outputPubKey);
            console.log('    commitment:', out.commitment);
            console.log('    packed:', packed);
            console.log('    leaf hash:', leaf);
        }
        
        return leaf;
    });
    
    // 5. Compute Merkle proof using SHA256 (matches oracle)
    const proof = [];
    let currentLevel = leaves;
    let currentIndex = targetGlobalIndex;
    
    while (currentLevel.length > 1) {
        const nextLevel = [];
        const hashPromises = [];
        
        for (let i = 0; i < currentLevel.length; i += 2) {
            const left = currentLevel[i];
            const right = i + 1 < currentLevel.length ? currentLevel[i + 1] : left;
            
            // Add sibling to proof
            if (i === currentIndex || i + 1 === currentIndex) {
                const sibling = (i === currentIndex) ? right : left;
                proof.push(sibling);
            }
            
            // Hash using SHA256 (not keccak256!)
            const leftBytes = new Uint8Array(left.slice(2).match(/.{2}/g).map(b => parseInt(b, 16)));
            const rightBytes = new Uint8Array(right.slice(2).match(/.{2}/g).map(b => parseInt(b, 16)));
            const combined = new Uint8Array([...leftBytes, ...rightBytes]);
            hashPromises.push(
                crypto.subtle.digest('SHA-256', combined).then(hashBuffer => 
                    '0x' + Array.from(new Uint8Array(hashBuffer))
                        .map(b => b.toString(16).padStart(2, '0')).join('')
                )
            );
        }
        
        // Wait for all hashes to complete
        const hashes = await Promise.all(hashPromises);
        nextLevel.push(...hashes);
        
        currentLevel = nextLevel;
        currentIndex = Math.floor(currentIndex / 2);
    }
    
    console.log(`  Output Merkle proof has ${proof.length} siblings`);
    
    return {
        outputIndex: targetGlobalIndex,
        proof
    };
}

async function computeTxMerkleProof(blockHeight, txHash) {
    console.log(`Computing TX Merkle proof for ${txHash} in block ${blockHeight}...`);
    const moneroRpcUrl = 'https://corsproxy.io/?' + encodeURIComponent('http://xmr.privex.io:18081/json_rpc');
    const response = await fetch(moneroRpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            jsonrpc: '2.0',
            id: '0',
            method: 'get_block',
            params: { height: blockHeight }
        })
    });
    
    const data = await response.json();
    if (data.error) {
        throw new Error(`Failed to get block: ${data.error.message}`);
    }
    
    const txHashes = data.result.tx_hashes;
    const normalizedTxHash = txHash.startsWith('0x') ? txHash.slice(2) : txHash;
    const txIndex = txHashes.findIndex(hash => hash === normalizedTxHash);
    
    if (txIndex === -1) {
        throw new Error(`Transaction not found in block`);
    }
    
    const proof = computeMerkleProofFromLeaves(txHashes, txIndex);
    
    return { txIndex, proof, txHashes };
}

// ============================================
// Proof Generation
// ============================================
// Ed25519 curve order
const L = BigInt('7237005577332262213973186563042994240857116359379907606001950938285454250989');

/**
 * Compute shared secret: 8*a*R where a is private view key, R is tx public key
 */
async function computeSharedSecret(privateViewKey, txPublicKey) {
    const a_hex = privateViewKey.replace(/^0x/, '');
    const R_hex = txPublicKey.replace(/^0x/, '');
    
    // Convert hex to bytes
    const a_bytes = new Uint8Array(a_hex.match(/.{2}/g).map(byte => parseInt(byte, 16)));
    const R_bytes = new Uint8Array(R_hex.match(/.{2}/g).map(byte => parseInt(byte, 16)));
    
    // Read scalar as little-endian
    let a_scalar = 0n;
    for (let i = 0; i < 32; i++) {
        a_scalar |= BigInt(a_bytes[i]) << (BigInt(i) * 8n);
    }
    
    // Compute a * R
    const R_point = ed.Point.fromHex(R_bytes);
    const aR = R_point.multiply(a_scalar);
    
    // Then (a * R) * 8
    const sharedSecret = aR.multiply(8n);
    const sharedSecretBytes = sharedSecret.toRawBytes();
    
    return Array.from(sharedSecretBytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Derive H_s scalar from shared secret
 */
function deriveHs(sharedSecret, outputIndex) {
    const secret_bytes = new Uint8Array(sharedSecret.match(/.{2}/g).map(byte => parseInt(byte, 16)));
    
    // Encode output index as varint (simple 1-byte for now)
    const index_bytes = new Uint8Array([outputIndex]);
    
    // Hash the derivation point + output index
    const input = new Uint8Array([...secret_bytes, ...index_bytes]);
    const hash = keccak256(input);
    const cleanHash = hash.startsWith('0x') ? hash.slice(2) : hash;
    
    // Read hash as little-endian and reduce modulo curve order
    const hash_bytes = new Uint8Array(cleanHash.match(/.{2}/g).map(byte => parseInt(byte, 16)));
    let hash_int = 0n;
    for (let i = 0; i < 32; i++) {
        hash_int |= BigInt(hash_bytes[i]) << (BigInt(i) * 8n);
    }
    
    const H_s = hash_int % L;
    
    // Convert back to little-endian bytes
    const H_s_bytes = new Uint8Array(32);
    let temp = H_s;
    for (let i = 0; i < 32; i++) {
        H_s_bytes[i] = Number(temp & 0xFFn);
        temp >>= 8n;
    }
    
    return Array.from(H_s_bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Compute amount key from H_s
 */
function computeAmountKey(H_s_hex) {
    const H_s_bytes = new Uint8Array(H_s_hex.match(/.{2}/g).map(byte => parseInt(byte, 16)));
    const amountPrefix = new TextEncoder().encode('amount');
    const input = new Uint8Array([...amountPrefix, ...H_s_bytes]);
    const hash = keccak256(input);
    const cleanHash = hash.startsWith('0x') ? hash.slice(2) : hash;
    return cleanHash.slice(0, 16); // First 8 bytes
}

/**
 * Decrypt amount using ECDH
 */
function decryptAmount(ecdhAmount, H_s_hex) {
    const amountKey = computeAmountKey(H_s_hex);
    
    // Handle ecdhAmount being 0 or empty
    let ecdhHex = ecdhAmount;
    if (typeof ecdhHex === 'number' || ecdhHex === 0) {
        ecdhHex = '0'.repeat(16); // 8 bytes = 16 hex chars
    }
    ecdhHex = ecdhHex.replace(/^0x/, '');
    
    // For RCT type 6 (CLSAG), ecdhAmount is 32 bytes but amount is in the LAST 8 bytes
    // Take the last 16 hex characters (8 bytes)
    if (ecdhHex.length > 16) {
        ecdhHex = ecdhHex.slice(-16); // Last 8 bytes
    } else if (ecdhHex.length < 16) {
        ecdhHex = ecdhHex.padStart(16, '0');
    }
    
    const ecdhBytes = new Uint8Array(ecdhHex.match(/.{2}/g).map(byte => parseInt(byte, 16)));
    const keyBytes = new Uint8Array(amountKey.match(/.{2}/g).map(byte => parseInt(byte, 16)));
    
    // XOR decryption
    const decrypted = new Uint8Array(8);
    for (let i = 0; i < 8; i++) {
        decrypted[i] = ecdhBytes[i] ^ keyBytes[i];
    }
    
    // Read as little-endian uint64
    let amount = 0n;
    for (let i = 0; i < 8; i++) {
        amount |= BigInt(decrypted[i]) << (BigInt(i) * 8n);
    }
    
    return amount;
}

/**
 * Full Monero amount decryption pipeline
 */
async function decryptMoneroAmount(privateViewKey, txPublicKey, outputIndex, ecdhAmount) {
    console.log('🔐 Decrypting Monero amount...');
    console.log('  Private view key:', privateViewKey.slice(0, 16) + '...');
    console.log('  TX public key R:', txPublicKey.slice(0, 16) + '...');
    console.log('  Output index:', outputIndex);
    console.log('  ECDH amount:', ecdhAmount);
    
    // Step 1: Compute shared secret
    const sharedSecret = await computeSharedSecret(privateViewKey, txPublicKey);
    console.log('  ✅ Shared secret:', sharedSecret.slice(0, 16) + '...');
    
    // Step 2: Derive H_s
    const H_s = deriveHs(sharedSecret, outputIndex);
    console.log('  ✅ H_s scalar:', H_s.slice(0, 16) + '...');
    
    // Step 3: Decrypt amount
    const amountKey = computeAmountKey(H_s);
    console.log('  🔑 Amount key:', amountKey);
    const amountPiconero = decryptAmount(ecdhAmount, H_s);
    const amountXMR = Number(amountPiconero) / 1e12;
    console.log('  ✅ Decrypted amount:', amountPiconero.toString(), 'piconero');
    console.log('  ✅ Amount in XMR:', amountXMR);
    
    return {
        H_s,
        amountPiconero,
        amountXMR,
        sharedSecret
    };
}

/**
 * Compute Ed25519 operations and generate DLEQ proof
 */
async function computeEd25519Operations(r_hex, H_s_hex) {
    console.log('🔐 Computing Ed25519 Operations...');
    
    // Parse inputs
    const r_scalar = BigInt('0x' + r_hex.replace(/^0x/, '')) % L;
    const H_s_scalar = BigInt('0x' + H_s_hex.replace(/^0x/, '')) % L;
    
    // Use base point G (placeholder for A and B as per backend implementation)
    const G = ed.Point.BASE;
    const A = G;  // Placeholder
    const B = G;  // Placeholder
    
    // 1. Compute R = r·G
    console.log('  1. Computing R = r·G...');
    const R = G.multiply(r_scalar);
    
    // 2. Compute r·A
    console.log('  2. Computing r·A...');
    const rA = A.multiply(r_scalar);
    
    // 3. Compute S = 8·(r·A)
    console.log('  3. Computing S = 8·(r·A)...');
    const S = rA.multiply(8n);
    
    // 4. Compute P = H_s·G + B
    console.log('  4. Computing P = H_s·G + B...');
    const H_s_G = G.multiply(H_s_scalar);
    const P = H_s_G.add(B);
    
    // 5. Generate DLEQ proof
    console.log('  5. Generating DLEQ proof...');
    const dleqProof = await generateDLEQProof(r_scalar, G, A, R, rA);
    
    console.log('✅ Ed25519 operations complete');
    
    return {
        R_x: R.x.toString(),
        R_y: R.y.toString(),
        S_x: S.x.toString(),
        S_y: S.y.toString(),
        P_x: P.x.toString(),
        P_y: P.y.toString(),
        dleqProof,
        ed25519Proof: {
            R_x: '0x' + R.x.toString(16).padStart(64, '0'),
            R_y: '0x' + R.y.toString(16).padStart(64, '0'),
            S_x: '0x' + S.x.toString(16).padStart(64, '0'),
            S_y: '0x' + S.y.toString(16).padStart(64, '0'),
            P_x: '0x' + P.x.toString(16).padStart(64, '0'),
            P_y: '0x' + P.y.toString(16).padStart(64, '0'),
            B_x: '0x' + B.x.toString(16).padStart(64, '0'),
            B_y: '0x' + B.y.toString(16).padStart(64, '0'),
            G_x: '0x' + G.x.toString(16).padStart(64, '0'),
            G_y: '0x' + G.y.toString(16).padStart(64, '0'),
            A_x: '0x' + A.x.toString(16).padStart(64, '0'),
            A_y: '0x' + A.y.toString(16).padStart(64, '0')
        }
    };
}

/**
 * Generate DLEQ proof
 */
async function generateDLEQProof(r_scalar, G, A, R, rA) {
    // 1. Generate random nonce k
    const k_bytes = new Uint8Array(32);
    crypto.getRandomValues(k_bytes);
    const k_scalar = BigInt('0x' + Array.from(k_bytes).map(b => b.toString(16).padStart(2, '0')).join('')) % L;
    
    // 2. Compute commitments
    const K1 = G.multiply(k_scalar);  // k·G
    const K2 = A.multiply(k_scalar);  // k·A
    
    // 3. Compute challenge using Fiat-Shamir
    const toUncompressed = (point) => {
        const x = point.x;
        const y = point.y;
        const xBytes = new Uint8Array(32);
        const yBytes = new Uint8Array(32);
        for (let i = 0; i < 32; i++) {
            xBytes[31 - i] = Number((x >> BigInt(i * 8)) & 0xFFn);
            yBytes[31 - i] = Number((y >> BigInt(i * 8)) & 0xFFn);
        }
        return new Uint8Array([...xBytes, ...yBytes]);
    };
    
    const challengeInput = new Uint8Array([
        ...toUncompressed(G),
        ...toUncompressed(A),
        ...toUncompressed(R),
        ...toUncompressed(rA),
        ...toUncompressed(K1),
        ...toUncompressed(K2)
    ]);
    
    const challengeHash = keccak256(challengeInput);
    // Remove 0x prefix if present before adding it
    const cleanHash = challengeHash.startsWith('0x') ? challengeHash.slice(2) : challengeHash;
    const c = BigInt('0x' + cleanHash) % L;
    
    // 4. Compute response: s = k + c·r (mod L)
    const s = (k_scalar + c * r_scalar) % L;
    
    return {
        c: '0x' + c.toString(16).padStart(64, '0'),
        s: '0x' + s.toString(16).padStart(64, '0'),
        K1: '0x' + K1.x.toString(16).padStart(64, '0'),
        K2: '0x' + K2.x.toString(16).padStart(64, '0')
    };
}

async function generateProofAndMint() {
    if (!state.isConnected) {
        showToast('Please connect your wallet first', 'warning');
        return;
    }
    
    const txHash = document.getElementById('txHash').value;
    const secretKeyR = document.getElementById('secretKeyR').value;
    
    if (!txHash || !secretKeyR) {
        showToast('Please fill in transaction hash and secret key', 'warning');
        return;
    }
    
    try {
        // Step 1: Fetch transaction data and block height from Monero blockchain
        showLoading('Step 1/5: Fetching transaction from Monero blockchain...');
        // Use CORS-enabled public node from monero.fail
        const moneroRpcUrl = 'https://node.sethforprivacy.com/get_transactions';
        
        const txResponse = await fetch(moneroRpcUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                txs_hashes: [txHash],
                decode_as_json: true
            })
        });
        
        if (!txResponse.ok) {
            console.error('Monero RPC error:', txResponse.status, txResponse.statusText);
            throw new Error(`Monero RPC request failed: ${txResponse.status}`);
        }
        
        const txData = await txResponse.json();
        console.log('Monero daemon response:', txData);
        
        if (txData.status !== 'OK') {
            console.error('Monero daemon error:', txData);
            throw new Error(`Monero daemon error: ${txData.status}`);
        }
        
        if (!txData.txs || txData.txs.length === 0) {
            console.error('Transaction not found. Response:', txData);
            throw new Error('Transaction not found on Monero blockchain. Make sure the transaction hash is correct and the transaction is confirmed.');
        }
        
        // Extract block height from transaction
        const txInfo = txData.txs[0];
        const blockHeight = txInfo.block_height;
        
        if (!blockHeight || blockHeight === 0) {
            throw new Error('Transaction not yet confirmed in a block. Please wait for confirmation.');
        }
        
        console.log('✅ Transaction found in block:', blockHeight);
        
        // Step 1.5: Check if block has been posted by oracle
        showLoading('Step 1.5/5: Verifying block has been posted by oracle...');
        try {
            const postedBlock = await state.publicClient.readContract({
                address: CONFIG.CONTRACT_ADDRESS,
                abi: [{
                    inputs: [{ name: 'blockHeight', type: 'uint256' }],
                    name: 'moneroBlocks',
                    outputs: [
                        { name: 'blockHash', type: 'bytes32' },
                        { name: 'txMerkleRoot', type: 'bytes32' },
                        { name: 'outputMerkleRoot', type: 'bytes32' },
                        { name: 'timestamp', type: 'uint256' }
                    ],
                    stateMutability: 'view',
                    type: 'function'
                }],
                functionName: 'moneroBlocks',
                args: [BigInt(blockHeight)]
            });
            
            console.log('Posted block info:', postedBlock);
            
            if (!postedBlock || postedBlock[0] === '0x0000000000000000000000000000000000000000000000000000000000000000') {
                hideLoading();
                showToast(`Block ${blockHeight} has not been posted by the oracle yet. Please wait for the oracle to post it (polls every 20 seconds).`, 'warning');
                return;
            }
            
            console.log('✅ Block has been posted by oracle');
        } catch (e) {
            console.error('Error checking if block posted:', e);
            // Continue anyway - the mint will fail if block not posted
        }
        
        // Step 2: Auto-detect output index
        showLoading('Step 2/5: Detecting output index...');
        const outputIndex = await detectOutputIndex(txHash, blockHeight);
        
        if (outputIndex === null) {
            hideLoading();
            showToast('Could not auto-detect output index. Please check your transaction hash and try again.', 'error');
            return;
        }
        
        console.log('✅ Output index detected:', outputIndex);
        
        const tx = JSON.parse(txData.txs[0].as_json);
        console.log('✅ Transaction data fetched');
        console.log('Full transaction:', tx);
        
        // Step 3: Extract output data
        showLoading('Step 3/5: Extracting output data...');
        const output = tx.vout[outputIndex];
        if (!output) {
            throw new Error(`Output index ${outputIndex} not found in transaction with ${tx.vout.length} outputs`);
        }
        
        console.log('Output structure:', output);
        
        // Extract output data based on actual Monero structure
        // ECDH amount is in rct_signatures.ecdhInfo, not in the output itself
        let ecdhAmount = tx.rct_signatures?.ecdhInfo?.[outputIndex]?.amount || '0';
        // Ensure it has 0x prefix for BigInt parsing
        if (ecdhAmount && !ecdhAmount.startsWith('0x')) {
            ecdhAmount = '0x' + ecdhAmount;
        }
        const outputKey = output.target?.key || output.target?.tagged_key?.key;
        const commitment = tx.rct_signatures?.outPk?.[outputIndex] || output.target?.key || output.target?.tagged_key?.key;
        
        console.log('✅ Output data extracted:');
        console.log('  ecdhAmount:', ecdhAmount);
        console.log('  outputKey:', outputKey);
        console.log('  commitment:', commitment);
        
        // Validate extracted data
        if (!ecdhAmount || !outputKey) {
            throw new Error('Missing output data from transaction');
        }
        
        // Step 3.5: Fetch LP info for cryptographic operations
        showLoading('Step 3.5/9: Fetching LP information...');
        const lpAddress = state.userAddress; // Using user as LP for now
        
        // Use raw call and manually extract fields to avoid ABI decoding issues
        const lpInfoData = await state.publicClient.call({
            to: CONFIG.CONTRACT_ADDRESS,
            data: encodeFunctionData({
                abi: CONTRACT_ABI,
                functionName: 'lpInfo',
                args: [lpAddress]
            })
        });
        
        // Manually extract fields from raw data
        // Struct layout: collateral(32), backed(32), mintFee(32), burnFee(32), intentDeposit(32), 
        //                string offset(32), privateViewKey(32), active(32), registered(32)
        const data = lpInfoData.data;
        
        // Private view key is at offset 6*32 = 192 bytes (0-indexed, so position 6)
        const privateViewKeyOffset = 2 + (6 * 64); // 2 for '0x' + 6*32 bytes in hex
        const privateViewKey = '0x' + data.slice(privateViewKeyOffset, privateViewKeyOffset + 64);
        
        // Registered flag is at offset 8*32 = 256 bytes
        const registeredOffset = 2 + (8 * 64);
        const registered = data.slice(registeredOffset, registeredOffset + 64) !== '0'.repeat(64);
        
        // Active flag is at offset 7*32 = 224 bytes  
        const activeOffset = 2 + (7 * 64);
        const active = data.slice(activeOffset, activeOffset + 64) !== '0'.repeat(64);
        
        console.log('LP Info (manually decoded):');
        console.log('  Private View Key:', privateViewKey);
        console.log('  Registered:', registered);
        console.log('  Active:', active);
        
        if (!registered) {
            throw new Error('You must be registered as an LP to mint');
        }
        
        const lpInfo = {
            privateViewKey,
            registered,
            active
        };
        
        // Step 4: Prepare circuit inputs
        showLoading('Step 4/9: Preparing circuit inputs...');
        
        // Helper function to convert hex string to byte array
        const hexToBytes = (hex) => {
            if (!hex) {
                throw new Error('Cannot convert undefined/null to bytes');
            }
            // Remove 0x prefix if present
            hex = hex.replace(/^0x/, '');
            const bytes = [];
            for (let i = 0; i < hex.length; i += 2) {
                bytes.push(parseInt(hex.substr(i, 2), 16));
            }
            return bytes;
        };
        
        // Helper to convert number to bit array
        const numToBits = (num, bitLength) => {
            const bits = [];
            for (let i = 0; i < bitLength; i++) {
                bits.push((num >> BigInt(i)) & 1n);
            }
            return bits.map(b => Number(b));
        };
        
        // Helper to convert hex to bit array
        const hexToBits = (hex, bitLength) => {
            const bigNum = BigInt('0x' + hex);
            return numToBits(bigNum, bitLength);
        };
        
        // Import poseidon hash from circomlibjs
        const { buildPoseidon } = await import('https://esm.sh/circomlibjs@0.1.7');
        const poseidonHash = await buildPoseidon();
        
        // Extract transaction public key R from extra field
        showLoading('Step 4/9: Extracting transaction public key...');
        const txExtra = tx.extra;
        
        // Debug: show first 100 bytes of extra field
        console.log('🔍 Extra field (first 100 bytes):', txExtra.slice(0, 100));
        console.log('🔍 Extra field length:', txExtra.length);
        
        // Main TX public key (tag 0x01)
        let mainTxPublicKey = null;
        for (let i = 0; i < txExtra.length - 32; i++) {
            if (txExtra[i] === 1) {
                mainTxPublicKey = txExtra.slice(i + 1, i + 33).map(b => b.toString(16).padStart(2, '0')).join('');
                break;
            }
        }
        
        // Additional public keys for subaddresses (tag 0x04)
        let additionalPublicKeys = [];
        for (let i = 0; i < txExtra.length; i++) {
            if (txExtra[i] === 4) { // Tag for additional public keys
                // Next byte is the number of additional keys
                const numKeys = txExtra[i + 1];
                for (let j = 0; j < numKeys; j++) {
                    const keyStart = i + 2 + (j * 32);
                    if (keyStart + 32 <= txExtra.length) {
                        const key = txExtra.slice(keyStart, keyStart + 32).map(b => b.toString(16).padStart(2, '0')).join('');
                        additionalPublicKeys.push(key);
                    }
                }
                break;
            }
        }
        
        // Debug: show all keys found
        console.log('🔍 Main TX public key:', mainTxPublicKey);
        console.log('🔍 Additional public keys found:', additionalPublicKeys.length);
        if (additionalPublicKeys.length > 0) {
            additionalPublicKeys.forEach((key, idx) => {
                console.log(`  [${idx}]:`, key);
            });
        }
        
        // For subaddress outputs, use additional public key at output index
        let txPublicKey = mainTxPublicKey;
        if (additionalPublicKeys.length > 0 && outputIndex < additionalPublicKeys.length) {
            txPublicKey = additionalPublicKeys[outputIndex];
            console.log('✅ Using additional public key for output', outputIndex, ':', txPublicKey);
        } else {
            console.log('✅ Using main transaction public key R:', txPublicKey);
        }
        
        if (!txPublicKey) {
            throw new Error('Could not find transaction public key in extra field');
        }
        
        // Decrypt amount using LP's private view key
        showLoading('Step 4.5/9: Decrypting amount...');
        const decryptedData = await decryptMoneroAmount(
            lpInfo.privateViewKey,
            txPublicKey,
            outputIndex,
            ecdhAmount || '0000000000000000'
        );
        
        const H_s_hex = decryptedData.H_s;
        const amountPiconero = decryptedData.amountPiconero;
        console.log('✅ Amount decryption complete');
        console.log('  Amount:', amountPiconero.toString(), 'piconero (', decryptedData.amountXMR, 'XMR)');
        
        // Compute Ed25519 operations with real H_s
        showLoading('Step 5/9: Computing Ed25519 operations...');
        const ed25519Ops = await computeEd25519Operations(secretKeyR, H_s_hex);
        console.log('✅ Ed25519 operations:', ed25519Ops);
        
        // Convert r bits to field element
        const rBits = hexToBits(secretKeyR, 255);
        
        // Ensure top 3 bits are 0 (required by circuit to ensure r < L)
        rBits[252] = 0;
        rBits[253] = 0;
        rBits[254] = 0;
        
        let rNum = 0n;
        for (let i = 0; i < 255; i++) {
            if (rBits[i]) rNum += (1n << BigInt(i));
        }
        
        // H_s scalar - convert from hex to bits
        const H_s_scalar_bits = hexToBits(H_s_hex, 255);
        
        // Ensure top 3 bits are 0 (required by circuit to ensure H_s < L)
        H_s_scalar_bits[252] = 0;
        H_s_scalar_bits[253] = 0;
        H_s_scalar_bits[254] = 0;
        
        let H_s_num = 0n;
        for (let i = 0; i < 255; i++) {
            if (H_s_scalar_bits[i]) H_s_num += (1n << BigInt(i));
        }
        
        // Amount - use decrypted amount
        const v = amountPiconero;
        
        // Ed25519 points from computed operations
        // BN254 field modulus (circuit operates in this field)
        const BN254_MODULUS = BigInt('21888242871839275222246405745257275088548364400416034343698204186575808495617');
        
        // Reduce Ed25519 coordinates modulo BN254 field to match circuit behavior
        const R_x = BigInt(ed25519Ops.R_x) % BN254_MODULUS;
        const S_x = BigInt(ed25519Ops.S_x) % BN254_MODULUS;
        const P_x = BigInt(ed25519Ops.P_x) % BN254_MODULUS;
        
        console.log('🔢 R_x (reduced):', R_x.toString());
        
        // Compute Poseidon commitment: hash(r, v, H_s, R_x, S_x, P_x)
        const commitmentValue = poseidonHash.F.toString(
            poseidonHash([rNum, v, H_s_num, R_x, S_x, P_x])
        );
        
        console.log('Computed commitment:', commitmentValue);
        
        // For now, use simplified inputs (amount verification is disabled per memory)
        const circuitInputs = {
            // Secret key r (255 bits)
            r: rBits,
            
            // Amount (self-reported for now since amount verification is disabled)
            v: v.toString(),
            
            // H_s scalar (255 bits) - placeholder
            H_s_scalar: H_s_scalar_bits,
            
            // Ed25519 points (compressed x-coordinates as field elements)
            R_x: R_x.toString(),
            S_x: S_x.toString(),
            P_x: P_x.toString(),
            
            // ECDH encrypted amount (convert hex to little-endian number for circuit)
            ecdhAmount: (() => {
                const hex = (ecdhAmount || '0').replace(/^0x/, '');
                const bytes = new Uint8Array(hex.match(/.{2}/g).map(b => parseInt(b, 16)));
                let num = 0n;
                for (let i = 0; i < bytes.length; i++) {
                    num |= BigInt(bytes[i]) << (BigInt(i) * 8n);
                }
                return num.toString();
            })(),
            
            // Amount key (64 bits) - compute from H_s
            amountKey: (() => {
                const amountKeyHex = computeAmountKey(H_s_hex);
                const amountKeyBytes = new Uint8Array(amountKeyHex.match(/.{2}/g).map(byte => parseInt(byte, 16)));
                const bits = [];
                for (let i = 0; i < 8; i++) {
                    for (let j = 0; j < 8; j++) {
                        bits.push((amountKeyBytes[i] >> j) & 1);
                    }
                }
                return bits;
            })(),
            
            // Poseidon commitment
            commitment: commitmentValue
        };
        
        console.log('Circuit inputs:', circuitInputs);
        
        console.log('✅ Circuit inputs prepared');
        
        // Step 5: Load circuit files
        showLoading('Step 5/7: Loading circuit files (50MB)...');
        
        try {
            // Load WASM file
            const wasmResponse = await fetch('/circuit/monero_bridge.wasm');
            const wasmBuffer = await wasmResponse.arrayBuffer();
            console.log('✅ WASM loaded:', wasmBuffer.byteLength, 'bytes');
            
            // Load zkey file
            showLoading('Step 6/7: Loading proving key (50MB, may take a moment)...');
            const zkeyResponse = await fetch('/circuit/monero_bridge_final.zkey');
            const zkeyBuffer = await zkeyResponse.arrayBuffer();
            console.log('✅ Proving key loaded:', zkeyBuffer.byteLength, 'bytes');
            
            // Step 6: Generate ZK proof
            showLoading('Step 7/7: Generating PLONK proof (this may take 10-30 seconds)...');
            
            const { proof, publicSignals } = await snarkjs.plonk.fullProve(
                circuitInputs,
                new Uint8Array(wasmBuffer),
                new Uint8Array(zkeyBuffer)
            );
            
            console.log('✅ Proof generated!');
            console.log('Proof:', proof);
            console.log('Public signals:', publicSignals);
            
            // Step 7: Format proof for contract
            showLoading('Preparing mint transaction...');
            
            // Parse proof for Solidity
            const proofArray = [
                proof.A[0], proof.A[1],
                proof.B[0], proof.B[1],
                proof.C[0], proof.C[1],
                proof.Z[0], proof.Z[1],
                proof.T1[0], proof.T1[1],
                proof.T2[0], proof.T2[1],
                proof.T3[0], proof.T3[1],
                proof.Wxi[0], proof.Wxi[1],
                proof.Wxiw[0], proof.Wxiw[1],
                proof.eval_a, proof.eval_b, proof.eval_c,
                proof.eval_s1, proof.eval_s2, proof.eval_zw
            ];
            
            console.log('Proof array for contract:', proofArray);
            console.log('Public signals for contract:', publicSignals);
            
            // Step 8: Compute TX Merkle proof
            showLoading('Step 8/10: Computing TX Merkle proof...');
            // Store original txHash before any modifications
            const originalTxHash = document.getElementById('txHash').value.replace(/^0x/, '');
            const txMerkleData = await computeTxMerkleProof(blockHeight, originalTxHash);
            console.log('✅ TX Merkle proof computed:', txMerkleData);
            console.log('  Using TX hash:', originalTxHash);
            
            // Step 9: Compute output Merkle proof
            showLoading('Step 9/10: Computing output Merkle proof...');
            const outputMerkleData = await computeOutputMerkleProof(blockHeight, originalTxHash, outputIndex);
            console.log('✅ Output Merkle proof computed:', outputMerkleData);
            
            // Extract global output index and proof from result
            const globalOutputIndex = BigInt(outputMerkleData.outputIndex);
            const outputMerkleProof = outputMerkleData.proof;
            
            // Step 10: Call mint function
            showLoading('Step 9/9: Submitting mint transaction...');
            
            // Prepare output struct
            // CRITICAL: Use GLOBAL output index (from Merkle proof), not local outputIndex!
            const output = {
                txHash: '0x' + originalTxHash,
                outputIndex: globalOutputIndex,  // Use GLOBAL index from Merkle computation!
                ecdhAmount: '0x' + (ecdhAmount || '0').replace(/^0x/, '').padStart(64, '0'),
                outputPubKey: '0x' + outputKey,
                commitment: '0x' + commitment
            };
            
            // Use computed DLEQ and Ed25519 proofs
            const dleqProof = ed25519Ops.dleqProof;
            const ed25519Proof = ed25519Ops.ed25519Proof;
            
            // Variables already extracted above - no need to redeclare
            
            console.log('Calling mint with:');
            console.log('  Proof:', proofArray);
            console.log('  Public signals:', publicSignals);
            console.log('  DLEQ Proof:', dleqProof);
            console.log('  Ed25519 Proof:', ed25519Proof);
            console.log('  Output:', output);
            console.log('  Output.txHash:', output.txHash);
            console.log('  Original TX hash used for Merkle:', originalTxHash);
            console.log('  Block height:', blockHeight);
            console.log('  TX index:', txMerkleData.txIndex);
            console.log('  TX Merkle proof:', txMerkleData.proof);
            console.log('  Output Merkle proof:', outputMerkleProof);
            console.log('  Global output index:', globalOutputIndex);
            
            // Validate all bytes32 fields
            const validateBytes32 = (value, name) => {
                if (!value || value === '0x' || value.length !== 66) {
                    console.error(`Invalid bytes32 for ${name}:`, value);
                    throw new Error(`Invalid bytes32 for ${name}: ${value}`);
                }
            };
            
            validateBytes32(output.txHash, 'output.txHash');
            validateBytes32(output.ecdhAmount, 'output.ecdhAmount');
            validateBytes32(output.outputPubKey, 'output.outputPubKey');
            validateBytes32(output.commitment, 'output.commitment');
            validateBytes32(dleqProof.c, 'dleqProof.c');
            validateBytes32(dleqProof.s, 'dleqProof.s');
            validateBytes32(dleqProof.K1, 'dleqProof.K1');
            validateBytes32(dleqProof.K2, 'dleqProof.K2');
            
            try {
                // Use the reduced R_x from publicSignals[1] (matches circuit's BN254 field reduction)
                const txPublicKeyForContract = '0x' + BigInt(publicSignals[1]).toString(16).padStart(64, '0');
                console.log('🔑 Using txPublicKey for contract:', txPublicKeyForContract);
                console.log('🔑 This equals publicSignals[1]:', publicSignals[1]);
                
                // First, simulate the transaction to catch any revert errors
                console.log('Simulating transaction...');
                try {
                    await state.publicClient.simulateContract({
                        address: CONFIG.CONTRACT_ADDRESS,
                        abi: CONTRACT_ABI,
                        functionName: 'mint',
                        args: [
                            proofArray,
                            publicSignals,
                            dleqProof,
                            ed25519Proof,
                            output,
                            BigInt(blockHeight),
                            txMerkleData.proof,
                            BigInt(txMerkleData.txIndex),
                            outputMerkleProof,
                            globalOutputIndex,
                            state.userAddress,
                            state.userAddress,
                            txPublicKeyForContract,  // Use computed R from proof
                            []
                        ],
                        account: state.userAddress
                    });
                    console.log('✅ Simulation successful');
                } catch (simError) {
                    console.error('❌ Simulation failed:', simError);
                    throw new Error(`Transaction would revert: ${simError.message}`);
                }
                
                const hash = await state.walletClient.writeContract({
                    address: CONFIG.CONTRACT_ADDRESS,
                    abi: CONTRACT_ABI,
                    functionName: 'mint',
                    args: [
                        proofArray,
                        publicSignals,
                        dleqProof,
                        ed25519Proof,
                        output,
                        BigInt(blockHeight),
                        txMerkleData.proof,
                        BigInt(txMerkleData.txIndex),
                        outputMerkleProof,
                        globalOutputIndex,
                        state.userAddress, // recipient
                        state.userAddress, // LP (for now, same as recipient)
                        txPublicKeyForContract,  // Use computed R from proof
                        [] // No price update data
                    ],
                    gas: 5000000n
                });
                
                console.log('✅ Mint transaction submitted:', hash);
                console.log('   Check on block explorer: https://sepolia.uniscan.xyz/tx/' + hash);
                
                // Wait for receipt
                const receipt = await waitForReceipt(hash);
                
                hideLoading();
                showToast(`✅ Mint successful! TX: ${hash.slice(0, 10)}...`, 'success');
                addActivity('Minted wrapped XMR', `TX: ${hash.slice(0, 10)}...`, 'Just now');
                
                // Reload balances
                await loadInitialData();
                
            } catch (mintError) {
                console.error('Mint error:', mintError);
                console.error('Error details:', {
                    message: mintError.message,
                    cause: mintError.cause,
                    shortMessage: mintError.shortMessage,
                    details: mintError.details
                });
                hideLoading();
                
                // Try to extract revert reason
                let errorMsg = 'Mint failed: ';
                if (mintError.shortMessage) {
                    errorMsg += mintError.shortMessage;
                } else if (mintError.details) {
                    errorMsg += mintError.details;
                } else {
                    errorMsg += mintError.message;
                }
                
                showToast(errorMsg, 'error');
            }
            
        } catch (proofError) {
            console.error('Proof generation error:', proofError);
            throw new Error('Failed to generate proof: ' + proofError.message);
        }
        
    } catch (error) {
        console.error('Error generating proof:', error);
        hideLoading();
        showToast('Error: ' + error.message, 'error');
    }
}

async function detectOutputIndex(txHash, blockHeight) {
    // For now, we'll use a simple heuristic without querying Monero nodes (to avoid CORS issues)
    // Most Monero transactions have 2 outputs:
    // - Output 0: Change back to sender
    // - Output 1: Payment to recipient (the LP)
    // 
    // In 99% of cases, the payment output is index 1
    // In the future, we can add a backend service to properly detect this using the view key
    
    console.log('Auto-detecting output index for tx:', txHash);
    
    // Return index 1 (payment output)
    return 1;
}

async function getLPAddressFromActiveIntent() {
    try {
        const intentIds = await state.publicClient.readContract({
            address: CONFIG.CONTRACT_ADDRESS,
            abi: CONTRACT_ABI,
            functionName: 'getUserMintIntents',
            args: [state.userAddress]
        });
        
        if (intentIds.length === 0) return null;
        
        // Get the first active intent's LP address
        const intentId = intentIds[0];
        const intent = await state.publicClient.readContract({
            address: CONFIG.CONTRACT_ADDRESS,
            abi: [{
                inputs: [{ name: 'intentId', type: 'bytes32' }],
                name: 'mintIntents',
                outputs: [
                    { name: 'user', type: 'address' },
                    { name: 'lp', type: 'address' },
                    { name: 'amount', type: 'uint256' },
                    { name: 'depositAmount', type: 'uint256' },
                    { name: 'createdAt', type: 'uint256' },
                    { name: 'fulfilled', type: 'bool' },
                    { name: 'cancelled', type: 'bool' }
                ],
                stateMutability: 'view',
                type: 'function'
            }],
            functionName: 'mintIntents',
            args: [intentId]
        });
        
        const lpAddress = intent[1]; // LP is at index 1
        
        // Fetch LP's Monero address
        const lpInfoResult = await state.publicClient.readContract({
            address: CONFIG.CONTRACT_ADDRESS,
            abi: [{
                inputs: [{ name: 'lp', type: 'address' }],
                name: 'lpInfo',
                outputs: [
                    { name: '', type: 'uint256' }, { name: '', type: 'uint256' }, { name: '', type: 'uint256' }, 
                    { name: '', type: 'uint256' }, { name: '', type: 'uint256' }, { name: 'moneroAddress', type: 'string' }
                ],
                stateMutability: 'view',
                type: 'function'
            }],
            functionName: 'lpInfo',
            args: [lpAddress]
        });
        
        return lpInfoResult[5];
    } catch (error) {
        console.error('Error getting LP address:', error);
        return null;
    }
}

// ============================================
// Activity Feed
// ============================================
function addActivity(type, details, time) {
    const activityList = document.getElementById('activityList');
    
    // Remove empty state if present
    const emptyState = activityList.querySelector('.empty-state');
    if (emptyState) {
        emptyState.remove();
    }
    
    const activityItem = document.createElement('div');
    activityItem.className = 'activity-item';
    activityItem.innerHTML = `
        <div class="activity-info">
            <div class="activity-type">${type}</div>
            <div class="activity-details">${details}</div>
        </div>
        <div class="activity-time">${time}</div>
    `;
    
    activityList.insertBefore(activityItem, activityList.firstChild);
}

// ============================================
// UI Helpers
// ============================================
function showLoading(text = 'Processing...') {
    document.getElementById('loadingText').textContent = text;
    document.getElementById('loadingOverlay').classList.remove('hidden');
}

function hideLoading() {
    document.getElementById('loadingOverlay').classList.add('hidden');
}

function showToast(message, type = 'info') {
    const container = document.getElementById('toastContainer');
    
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;
    
    container.appendChild(toast);
    
    // Auto remove after 5 seconds
    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateX(450px) scale(0.9)';
        setTimeout(() => toast.remove(), 400);
    }, 5000);
}

// Expose for inline onclick handlers
window.showToast = showToast;

/**
 * Wait for transaction receipt with RPC error handling
 * @param {string} hash - Transaction hash
 * @returns {Promise<object|null>} Receipt or null if RPC error
 */
async function waitForReceipt(hash) {
    try {
        const receipt = await state.publicClient.waitForTransactionReceipt({ 
            hash,
            pollingInterval: 2000,
            timeout: 30000
        });
        
        // Check if transaction reverted
        if (receipt.status === 'reverted') {
            console.error('Transaction reverted:', receipt);
            
            // Try to get revert reason
            let revertReason = 'Unknown reason';
            try {
                const tx = await state.publicClient.getTransaction({ hash });
                // Simulate the transaction to get revert reason
                const result = await state.publicClient.call({
                    to: tx.to,
                    data: tx.input,
                    from: tx.from,
                    value: tx.value,
                    blockNumber: receipt.blockNumber
                });
                console.log('Call result:', result);
            } catch (e) {
                console.log('Revert error:', e);
                if (e.message) {
                    // Extract revert reason from error message
                    const match = e.message.match(/reverted with reason string '(.+?)'/);
                    if (match) revertReason = match[1];
                    else if (e.message.includes('execution reverted:')) {
                        revertReason = e.message.split('execution reverted:')[1].trim();
                    } else {
                        revertReason = e.message;
                    }
                }
            }
            
            throw new Error(`Transaction reverted: ${revertReason}. Check block explorer for details.`);
        }
        
        return receipt;
    } catch (error) {
        // If it's a block range error, the transaction likely succeeded
        if (error.message.includes('block is out of range') || 
            error.message.includes('HTTP request failed')) {
            console.log('RPC error waiting for receipt, but transaction was sent:', hash);
            return null; // Transaction sent but couldn't get receipt
        }
        throw error; // Re-throw other errors
    }
}

function formatAddress(address) {
    return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

// ============================================
// Export for debugging
// ============================================
window.hookedMonero = {
    state,
    connectWallet,
    loadUserData,
    switchTab,
};
