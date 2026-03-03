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

// Contract addresses - These will be populated after deployment
export const CONTRACTS = {
    vaultManager: '0x0000000000000000000000000000000000000000', // TODO: Update after deployment
    wrappedMonero: '0x0000000000000000000000000000000000000000', // TODO: Update after deployment
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
        'function initiateMint(address lpVault, uint256 xmrAmount, bytes32 claimCommitment, uint256 timeout) external payable returns (bytes32 requestId)',
        'function requestBurn(uint256 wsxmrAmount, address lpVault) external returns (bytes32 requestId)',
        'function finalizeMint(bytes32 requestId, bytes32 secret) external',
        'function finalizeBurn(bytes32 requestId, bytes32 secret) external',
        'function cancelMint(bytes32 requestId) external',
        'function updatePythPrices(bytes[] calldata priceUpdateData) external payable',
        'function getVault(address lpVault) external view returns (tuple(uint256 totalXmrLocked, uint256 totalCollateral, address collateralToken, uint256 collateralizationRatio, uint256 mintGriefingDeposit, bool isActive))',
        'function getMintRequest(bytes32 requestId) external view returns (tuple(address user, address lpVault, uint256 xmrAmount, bytes32 claimCommitment, uint256 griefingDeposit, uint256 timeout, uint8 status))',
        'function getBurnRequest(bytes32 requestId) external view returns (tuple(address user, address lpVault, uint256 wsxmrAmount, bytes32 secretHash, uint256 timeout, uint8 status))',
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
