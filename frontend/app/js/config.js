// Configuration for Phantom Agent
// Contract addresses are loaded from the canonical root deployment.json (window.DEPLOYMENT).

const D = window.DEPLOYMENT || {};
const DC = D.contracts || {};
const DE = D.externalContracts || {};
const DP = D.pool || {};
const DLC = D.lpConfig || {};

export const NETWORKS = {
    gnosis: {
        id: D.chainId || 100,
        name: 'Gnosis Chain',
        rpcUrl: D.rpcUrl || 'https://rpc.gnosischain.com',
        blockExplorer: D.explorer || 'https://gnosisscan.io',
        nativeCurrency: {
            name: 'xDAI',
            symbol: 'xDAI',
            decimals: 18
        }
    }
};

// Contract addresses - source of truth: ../../deployment.json
export const CONTRACTS = {
    hub: DC.wsXmrHub || '0x5645c2b053297c69e9ac543851943a96b65d0925',
    wsxmrToken: DC.wsXMR || '0xbb364f197a8429bfa7a991bbbfc104a4dc53f6fa',
    liquidityRouter: DC.liquidityRouter || '0xdc0d3eddd8ee8b63611156de39b6f05cad2bb0b0',
    sDAI: DE.sDAI || '0xaf204776c7245bF4147c2612BF6e5972Ee483701',
    uniswapV3Pool: DP.uniswapV3Pool || '0xa62580f4cf7ac62075fd425a2e64b953baff623c',
    // Default LP vault to use for mints (the active LP running the LP node)
    defaultLpVault: DLC.defaultLpVault || '0x492c0b9F298cC49FE2644a2EBc6eA8dF848c72FB'
};

// LP Server Configuration
export const LP_SERVER_CONFIG = {
    // Default LP server URL (operator's server)
    defaultUrl: 'http://localhost:3001',
    // Endpoints
    endpoints: {
        info: '/info',
        quoteMint: '/quote/mint',
        quoteBurn: '/quote/burn',
        notifyMint: '/mint/notify',
        getMintStatus: '/mint/:id/status',
        getBurnStatus: '/burn/:id/status',
        confirmBurn: '/burn/:id/confirm'
    }
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
    // Default to public mainnet node
    // Users should configure their own node for privacy
    rpcUrl: 'https://xmr-node.cakewallet.com:18081',
    
    // Network type
    networkType: 'mainnet', // 'mainnet', 'testnet', or 'stagenet'
    
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
    minBurnAmount: 0, // No minimum - allow burning any amount
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

// Raw ABI for complex return types (parseAbi doesn't support tuples)
export const RAW_ABIS = {
    getVault: {
        inputs: [{ name: 'lpAddress', type: 'address' }],
        name: 'getVault',
        outputs: [{
            components: [
                { name: 'lpAddress', type: 'address' },
                { name: 'collateralShares', type: 'uint256' },
                { name: 'lockedCollateral', type: 'uint256' },
                { name: 'normalizedDebt', type: 'uint256' },
                { name: 'pendingDebt', type: 'uint256' },
                { name: 'maxMintBps', type: 'uint16' },
                { name: 'mintGriefingDeposit', type: 'uint256' },
                { name: 'mintReadyBond', type: 'uint256' },
                { name: 'mintFeeBps', type: 'uint16' },
                { name: 'burnRewardBps', type: 'uint16' },
                { name: 'liquidationNonce', type: 'uint256' },
                { name: 'mintNonce', type: 'uint256' },
                { name: 'minBurnAmount', type: 'uint256' },
                { name: 'active', type: 'bool' }
            ],
            name: '',
            type: 'tuple'
        }],
        stateMutability: 'view',
        type: 'function'
    },
    getMintRequest: {
        inputs: [{ name: 'requestId', type: 'bytes32' }],
        name: 'getMintRequest',
        outputs: [{
            components: [
                { name: 'requestId', type: 'bytes32' },
                { name: 'initiator', type: 'address' },
                { name: 'recipient', type: 'address' },
                { name: 'lpVault', type: 'address' },
                { name: 'xmrAmount', type: 'uint256' },
                { name: 'wsxmrAmount', type: 'uint256' },
                { name: 'feeAmount', type: 'uint256' },
                { name: 'claimCommitment', type: 'bytes32' },
                { name: 'timeout', type: 'uint256' },
                { name: 'griefingDeposit', type: 'uint256' },
                { name: 'lpBond', type: 'uint256' },
                { name: 'normalizedDebtAmount', type: 'uint256' },
                { name: 'vaultMintNonce', type: 'uint256' },
                { name: 'status', type: 'uint8' }
            ],
            name: '',
            type: 'tuple'
        }],
        stateMutability: 'view',
        type: 'function'
    },
    getBurnRequest: {
        inputs: [{ name: 'requestId', type: 'bytes32' }],
        name: 'getBurnRequest',
        outputs: [{
            components: [
                { name: 'requestId', type: 'bytes32' },
                { name: 'user', type: 'address' },
                { name: 'lpVault', type: 'address' },
                { name: 'wsxmrAmount', type: 'uint256' },
                { name: 'xmrAmount', type: 'uint256' },
                { name: 'lockedCollateral', type: 'uint256' },
                { name: 'rewardCollateral', type: 'uint256' },
                { name: 'secretHash', type: 'bytes32' },
                { name: 'deadline', type: 'uint256' },
                { name: 'vaultLiquidationNonce', type: 'uint256' },
                { name: 'normalizedDebtAmount', type: 'uint256' },
                { name: 'status', type: 'uint8' }
            ],
            name: '',
            type: 'tuple'
        }],
        stateMutability: 'view',
        type: 'function'
    }
};

// Contract ABIs (minimal, only what we need)
export const ABIS = {
    hub: [
        // Mint flow
        'function initiateMint(address lpVault, address recipient, uint256 xmrAmount, bytes32 claimCommitment, bytes32 userPublicKey) external payable returns (bytes32 requestId)',
        'function provideLPKey(bytes32 requestId, bytes32 lpPublicKey) external',
        'function setMintReady(bytes32 requestId) external payable',
        'function finalizeMint(bytes32 requestId, bytes32 secret) external',
        'function cancelMint(bytes32 requestId) external',
        'function lpPublicKeys(bytes32 requestId) external view returns (bytes32)',
        'function getUserMintRequests(address user) external view returns (bytes32[])',
        'function getVaultPendingMints(address lpVault) external view returns (bytes32[])',
        'function calculateWsxmrAmount(uint256 xmrAmount) external pure returns (uint256)',
        'function calculateMintFee(address lpVault, uint256 wsxmrAmount) external view returns (uint256)',

        // Burn flow — 4-step: requestBurn → proposeHash → confirmMoneroLock → finalizeBurn
        'function requestBurn(uint256 wsxmrAmount, address lpVault, address user, bytes32 claimCommitment) external returns (bytes32 requestId)',
        'function proposeHash(bytes32 requestId, bytes32 secretHash) external',
        'function confirmMoneroLock(bytes32 requestId) external',
        'function finalizeBurn(bytes32 requestId, bytes32 secret) external',
        'function claimSlashedCollateral(bytes32 requestId) external',
        'function cancelBurn(bytes32 requestId) external',
        'function getUserBurnRequests(address user) external view returns (bytes32[])',

        // Vault (LP-side)
        'function createVault() external',
        'function deactivateVault() external',
        'function depositCollateral(uint256 amount) external',
        'function depositShares(uint256 shares) external',
        'function withdrawCollateral(uint256 shares) external',
        'function setMintGriefingDeposit(uint256 deposit) external',
        'function setMintReadyBond(uint256 bond) external',
        'function setVaultMarketMetrics(uint16 mintFeeBps, uint16 burnRewardBps) external',
        'function setMaxMintBps(uint16 maxMintBps) external',
        'function setMinBurnAmount(uint256 minAmount) external',
        'function withdrawReturns(address token) external',
        'function getVaultHealth(address lpAddress) external view returns (uint256 ratio)',
        'function getVaultDebt(address lpAddress) external view returns (uint256)',
        'function getVaultCount() external view returns (uint256)',
        'function getVaultAtIndex(uint256 index) external view returns (address)',
        'function getPendingReturns(address user, address token) external view returns (uint256)',
        'function hasActiveVault(address lpAddress) external view returns (bool)',

        // Co-LP operations
        'function userOpenCoLP(address lpVault, uint256 wsxmrAmount, uint256 deadline) external returns (uint256 tokenId)',
        'function unwindCoLP(uint256 tokenId, uint256 deadline) external',
        'function rebalanceCoLP(uint256 tokenId, uint16 newRangeBps, uint256 deadline) external',
        'function getCoLPCapacity(address lpVault) external view returns (uint256 maxWsxmrAcceptable)',
        'function setMaxCoLPRange(uint16 newMaxBps) external',

        // Errors (so viem can decode reverts instead of showing "internal error")
        'error StalePrice()',
        'error PriceNormalizedToZero()',
        'error RefundFailed()',
        'error VaultDoesNotExist()',
        'error ZeroAmount()',
        'error InsufficientLPBuffer()',
        'error DeadlineExpired()',
        'error Unauthorized()',
        'error ReentrancyGuard()',
        'error ZeroAddress()',
        'error AlreadyInitialized()',
        'error InvalidRange()',
        'error PositionNotFound()',
        'error InsufficientCollateral()',
        'error InsufficientDebt()',
        'error InsufficientBond()',
        'error InvalidValue()',
        'error InvalidSecret()',
        'error InvalidStatus()',
        'error OnlyHub()',
        'error BelowMinimumBurn()',
        'error MaxBurnRequestsReached()',
        'error BurnAlreadyExists()',
        'error OnlyUserCanInitiate()',
        'error OnlyRouter()',
        'error DeadlineNotExpired()',
        'error GracePeriodOnlyUser()',
        'error BurnInvalidatedByLiquidation()',
        'error InvalidCommitment()',
        'error InvalidTimeout()',
        'error InsufficientDeposit()',
        'error MintAlreadyExists()',
        'error TimeoutNotReached()',
        'error VaultAlreadyExists()',
        'error MaxVaultsReached()',
        'error ExceedsMaxMargin()',
        'error ETHTransferFailed()',
        'error VaultHealthy()',
        'error CancelBurnsFirst()',
        'error InvalidPoolFeeTier()',
        'error CooldownActive()',
        'error XMRNotDipped()',
        'error WarChestEmpty()',
        'error InvalidSpotPrice()',
        'error InvalidEMAPrice()',
        'error PriceExponentMismatch()',
        'error InvalidConfig()',
        'error PoolNotInitialized()',
        'error PoolAlreadyInitialized()',

        // Oracle (RedStoneOracleFacet — user can update prices with RedStone data)
        'function updateOraclePrices(bytes[] calldata) external payable',
        'function getXmrPrice() external view returns (uint256)',
        'function getCollateralPrice() external view returns (uint256)',
        'function getXmrPriceWithAge(uint256 maxAge) external view returns (uint256)',
        'function getCollateralPriceWithAge(uint256 maxAge) external view returns (uint256)',

        // Events
        'event MintInitiated(bytes32 indexed requestId, address indexed initiator, address indexed recipient, address lpVault, uint256 xmrAmount, uint256 wsxmrAmount, uint256 feeAmount, bytes32 claimCommitment, uint256 timeout)',
        'event LPKeyProvided(bytes32 indexed requestId, bytes32 lpPublicKey)',
        'event MintReady(bytes32 indexed requestId)',
        'event MintFinalized(bytes32 indexed requestId, bytes32 secret)',
        'event MintCancelled(bytes32 indexed requestId)',
        'event BurnRequested(bytes32 indexed requestId, address indexed user, address indexed lpVault, uint256 wsxmrAmount, uint256 xmrAmount, uint256 rewardCollateral, bytes32 claimCommitment)',
        'event HashProposed(bytes32 indexed requestId, bytes32 secretHash)',
        'event BurnCommitted(bytes32 indexed requestId, uint256 deadline)',
        'event BurnFinalized(bytes32 indexed requestId, bytes32 secret, uint256 reward)',
        'event BurnSlashed(bytes32 indexed requestId, address indexed user, uint256 totalSeized)',
        'event BurnCancelled(bytes32 indexed requestId)',
        'event VaultCreated(address indexed lp)',
        'event CollateralDeposited(address indexed lp, uint256 amount, uint256 shares)',
        'event CollateralWithdrawn(address indexed lp, uint256 amount, uint256 shares)'
    ],

    liquidityRouter: [
        // LP side
        'function allocateLiquidity(uint256 sDAIAmount) external',
        'function withdrawSDAI(uint256 sDAIAmount) external',
        'function increaseUserApproval(address user, uint256 additionalSDAI) external',
        'function decreaseUserApproval(address user, uint256 reduceSDAI) external',
        // User side
        'function depositWsxmr(uint256 amount) external',
        'function withdrawWsXMR(uint256 wsxmrAmount) external',
        'function increaseLpApproval(address lp, uint256 additionalWsxmr) external',
        'function decreaseLpApproval(address lp, uint256 reduceWsxmr) external',
        'function burnFromInternalBalance(uint256 wsxmrAmount, address lpVault) external returns (bytes32)',
        // Positions
        'function createPosition(address lp, address user, uint256 sDAIAmount, uint256 wsxmrAmount, uint256 deadline) external returns (uint256)',
        'function createPositionWithPriceUpdate(address lp, address user, uint256 sDAIAmount, uint256 wsxmrAmount, uint256 deadline, bytes[] calldata oracleUpdateData) external payable returns (uint256)',
        'function closePosition(uint256 positionIndex, uint256 deadline, uint256 minTotalValueUSD) external',
        'function collectFees(uint256 positionIndex) external',
        'function withdrawFees() external',
        'function withdrawETH() external',
        // Views
        'function getLpAvailableLiquidity(address lp) external view returns (uint256)',
        'function getUserAvailableWsxmr(address user) external view returns (uint256)',
        'function lpApprovalAmount(address lp, address user) external view returns (uint256)',
        'function userApprovalAmount(address user, address lp) external view returns (uint256)',
        'function activePositionCount(address account) external view returns (uint256)',
        // Events
        'event PositionCreated(uint256 indexed positionIndex, uint256 dexTokenId, address indexed lp, address indexed user, uint256 sDAIAmount, uint256 wsxmrAmount)',
        'event PositionClosed(uint256 indexed positionIndex, uint256 sDAIReturned, uint256 wsxmrReturned)',
        'event LpApprovedUser(address indexed lp, address indexed user, uint256 amount)',
        'event UserApprovedLp(address indexed user, address indexed lp, uint256 amount)',
        'event ILSDAICredited(address indexed user, uint256 amount, uint256 positionIndex)',
        'event ILWsxmrCredited(address indexed lp, uint256 amount, uint256 positionIndex)'
    ],

    wsxmr: [
        'function balanceOf(address account) external view returns (uint256)',
        'function decimals() external view returns (uint8)',
        'function approve(address spender, uint256 amount) external returns (bool)',
        'function allowance(address owner, address spender) external view returns (uint256)',
        'function transfer(address to, uint256 amount) external returns (bool)',
        'function totalSupply() external view returns (uint256)'
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
