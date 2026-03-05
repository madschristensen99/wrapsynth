// Configuration for Phantom Agent
// Network and contract addresses

export const NETWORKS = {
    gnosis: {
        id: 100,
        name: 'Gnosis Chain',
        rpcUrl: 'https://rpc.gnosischain.com',
        blockExplorer: 'https://gnosisscan.io',
        nativeCurrency: {
            name: 'xDAI',
            symbol: 'xDAI',
            decimals: 18
        }
    }
};

// Contract addresses - Deployed on Gnosis Chain Mainnet
export const CONTRACTS = {
    vaultManager: '0x184fDC73f58B9b56e81CC150922661CF5A3d600F',
    wrappedMonero: '0x3100aE36ce786EfE1D68BC3863139c59018e739c',
    liquidityRouter: '0x8D8BE267BA4c326fFE02C4243a5261C7f0f9be81',
    pythOracle: '0x2880aB155794e7179c9eE2e38200202908C17B43' // Gnosis Pyth Oracle
};

// Pyth Network Configuration
export const PYTH_CONFIG = {
    hermesUrl: 'https://hermes.pyth.network',
    priceIds: {
        // XMR/USD price feed ID
        xmrUsd: '0x46b8cc9347f04391764a0361e0b17c3ba394b001e7c304f7650f6376e37c321d',
        // ETH/USD price feed ID  
        ethUsd: '0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace'
    },
    updateFee: 1n // Wei, will be calculated dynamically
};

// Token decimals
export const DECIMALS = {
    wsXMR: 8,      // EVM wsXMR token decimals
    XMR: 12,       // Monero atomic units decimals
    ETH: 18,       // ETH/xDAI decimals
    USD: 18        // Pyth price decimals
};

// Swap parameters
export const SWAP_CONFIG = {
    minMintAmount: 0.01, // Minimum XMR to mint
    minBurnAmount: 0.01, // Minimum wsXMR to burn
    defaultTimeout: 86400, // 24 hours in seconds
    pollInterval: 5000, // 5 seconds
    maxRetries: 3
};

// Storage keys for localStorage
export const STORAGE_KEYS = {
    activeSwap: 'phantom_active_swap',
    swapHistory: 'phantom_swap_history',
    userPreferences: 'phantom_preferences'
};

// Monero RPC configuration (for monitoring)
export const MONERO_CONFIG = {
    // This would typically point to a public Monero node or your own
    rpcUrl: 'https://xmr-node.cakewallet.com:18081',
    stagenetRpcUrl: 'https://stagenet.xmr-node.cakewallet.com:38081'
};

// Contract ABIs (minimal, only what we need)
export const ABIS = {
    vaultManager: [
        'function initiateMint(address lpVault, address recipient, uint256 xmrAmount, bytes32 claimCommitment, uint256 timeoutDuration) external payable returns (bytes32 requestId)',
        'function requestBurn(uint256 wsxmrAmount, address lpVault, address user) external returns (bytes32 requestId)',
        'function finalizeMint(bytes32 requestId, bytes32 secret) external',
        'function finalizeBurn(bytes32 requestId, bytes32 secret) external',
        'function cancelMint(bytes32 requestId) external',
        'function updatePythPrices(bytes[] calldata priceUpdateData) external payable',
        'function vaults(address lpVault) external view returns (uint256 collateralAmount, uint256 normalizedDebt, uint256 pendingDebt, uint256 lockedCollateral, address collateralAsset, uint256 mintGriefingDeposit, uint256 mintFeeBps, uint256 burnFeeBps, uint256 maxMintBps, bool active)',
        'function mintRequests(bytes32 requestId) external view returns (address user, address lpVault, address recipient, uint256 xmrAmount, bytes32 claimCommitment, uint256 griefingDeposit, uint256 deadline, uint8 status)',
        'function burnRequests(bytes32 requestId) external view returns (address user, address lpVault, uint256 wsxmrAmount, bytes32 secretHash, uint256 collateralLocked, uint256 deadline, uint8 status)',
        'function getXmrPrice() external view returns (uint256)',
        'function getCollateralPrice(address collateralAsset) external view returns (uint256)',
        'event MintInitiated(bytes32 indexed requestId, address indexed user, address indexed lpVault, uint256 xmrAmount, bytes32 claimCommitment)',
        'event MintReady(bytes32 indexed requestId, bytes32 secretHash)',
        'event MintFinalized(bytes32 indexed requestId, bytes32 secret)',
        'event BurnRequested(bytes32 indexed requestId, address indexed user, uint256 wsxmrAmount)',
        'event BurnCommitted(bytes32 indexed requestId, bytes32 secretHash)',
        'event BurnFinalized(bytes32 indexed requestId, bytes32 secret)'
    ],
    wrappedMonero: [
        'function balanceOf(address account) external view returns (uint256)',
        'function decimals() external view returns (uint8)',
        'function approve(address spender, uint256 amount) external returns (bool)',
        'function allowance(address owner, address spender) external view returns (uint256)'
    ],
    pythOracle: [
        'function getUpdateFee(bytes[] calldata updateData) external view returns (uint256 feeAmount)',
        'function updatePriceFeeds(bytes[] calldata updateData) external payable'
    ]
};

// EIP-191 message prefix for deterministic signing
export const MESSAGE_PREFIX = 'Phantom Agent Swap Authorization';

// Helper to create deterministic message for signing
export function createSwapMessage(address, action, amount, destination = null) {
    const parts = [
        MESSAGE_PREFIX,
        `Address: ${address}`,
        `Action: ${action}`,
        `Amount: ${amount}`
    ];
    
    if (destination) {
        parts.push(`Destination: ${destination}`);
    }
    
    parts.push(`Timestamp: ${Date.now()}`);
    
    return parts.join('\n');
}
