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
    vaultManager: '0x839257DE37b22B377e545514e2eD0b4f92266F88',
    wrappedMonero: '0xf0114924F8e3d1D4dca68DEf1F3Ea402EF5B32a2',
    liquidityRouter: '0x7Ed870F86ae9c7ecE955185792FFF1Ac57dc743a',
    pythOracle: '0x2880aB155794e7179c9eE2e38200202908C17B43', // Gnosis Pyth Oracle
    // Default LP vault to use for mints (the active LP running the LP node)
    defaultLpVault: '0x492c0b9F298cC49FE2644a2EBc6eA8dF848c72FB'
};

// Pyth Network Configuration
export const PYTH_CONFIG = {
    hermesUrl: 'https://hermes.pyth.network/api',
    priceIds: {
        // XMR/USD price feed ID
        xmrUsd: '0x46b8cc9347f04391764a0361e0b17c3ba394b001e7c304f7650f6376e37c321d',
        // sDAI/USD price feed ID (collateral asset)
        sdaiUsd: '0xb0948a5e5313200c632b51bb5ca32f6de0d36e9950a942d19751e833f70dabfd'
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

// Monero Network Configuration
export const MONERO_CONFIG = {
    // Default to public stagenet node for testing
    // Users should configure their own node for privacy
    rpcUrl: 'http://stagenet.xmr-tw.org:38081',
    
    // Network type
    networkType: 'stagenet', // 'mainnet', 'testnet', or 'stagenet'
    
    // Public nodes (users can select or add their own)
    publicNodes: {
        mainnet: [
            'https://xmr-node.cakewallet.com:18081',
            'https://node.moneroworld.com:18089',
            'https://nodes.hashvault.pro:18081'
        ],
        stagenet: [
            'http://stagenet.xmr-tw.org:38081',
            'http://stagenet.community.xmr.to:38081'
        ],
        testnet: [
            'http://testnet.xmr-tw.org:28081'
        ]
    },
    
    // Wallet refresh interval (ms)
    refreshInterval: 10000, // 10 seconds
    
    // Transaction confirmation blocks
    confirmations: 10
};

// Swap parameters
export const SWAP_CONFIG = {
    minMintAmount: 0.01, // Minimum XMR to mint
    minBurnAmount: 0.01, // Minimum wsXMR to burn
    defaultTimeout: 7200, // 2 hours in seconds (matches MAX_MINT_TIMEOUT)
    pollInterval: 5000, // 5 seconds
    maxRetries: 3
};

// Storage keys for localStorage
export const STORAGE_KEYS = {
    activeSwap: 'phantom_active_swap',
    swapHistory: 'phantom_swap_history',
    userPreferences: 'phantom_preferences'
};

// Contract ABIs (minimal, only what we need)
export const ABIS = {
    vaultManager: [
        'function initiateMint(address lpVault, address recipient, uint256 xmrAmount, bytes32 claimCommitment, uint256 timeoutDuration) external payable returns (bytes32 requestId)',
        'function updatePythPrices(bytes[] calldata pythUpdateData) external payable',
        'function requestBurn(uint256 wsxmrAmount, address lpVault, address user) external returns (bytes32 requestId)',
        'function finalizeMint(bytes32 requestId, bytes32 secret) external',
        'function finalizeBurn(bytes32 requestId, bytes32 secret) external',
        'function cancelMint(bytes32 requestId) external',
        'function vaults(address lpVault) external view returns (uint256 collateralAmount, uint256 normalizedDebt, uint256 pendingDebt, uint256 lockedCollateral, address collateralAsset, uint256 mintGriefingDeposit, uint256 mintFeeBps, uint256 burnFeeBps, uint256 maxMintBps, bool active)',
        'function getVault(address lpVault) external view returns (tuple(address lpAddress, uint256 collateralAmount, uint256 lockedCollateral, uint256 normalizedDebt, uint256 pendingDebt, uint16 maxMintBps, uint256 mintGriefingDeposit, uint16 mintFeeBps, uint16 burnRewardBps, uint256 mintNonce, uint256 liquidationNonce, bool active))',
        'function mintRequests(bytes32 requestId) external view returns (tuple(bytes32 requestId, address initiator, address recipient, address lpVault, uint256 xmrAmount, uint256 wsxmrAmount, uint256 feeAmount, bytes32 claimCommitment, uint256 timeout, uint256 griefingDeposit, uint256 normalizedDebtAmount, uint256 vaultMintNonce, uint8 status))',
        'function lpPublicKeys(bytes32 requestId) external view returns (bytes32)',
        'function burnRequests(bytes32 requestId) external view returns (address user, address lpVault, uint256 wsxmrAmount, bytes32 secretHash, uint256 collateralLocked, uint256 deadline, uint8 status)',
        'function getXmrPrice() external view returns (uint256)',
        'function getCollateralPrice() external view returns (uint256)',
        'event MintInitiated(bytes32 indexed requestId, address indexed initiator, address indexed recipient, address lpVault, uint256 xmrAmount, uint256 wsxmrAmount, uint256 feeAmount, bytes32 claimCommitment, uint256 timeout)',
        'event LPKeyProvided(bytes32 indexed requestId, bytes32 lpPublicKey)',
        'event MintReady(bytes32 indexed requestId)',
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
