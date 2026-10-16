// Wrapsynth multi-chain configuration.
//
// Each chain runs an INDEPENDENT wsXMR deployment — separate hub, token,
// collateral asset, LP vaults, and pool. There is no bridging between them.
// The user picks a chain explicitly; there is no default chain.
//
// Per-chain contract addresses come from deployment.<key>.json manifests
// (written by the forge deploy scripts, copied into frontend/). Manifests
// are fetched lazily on chain selection and cached.

export const CHAINS = {
    bnb: {
        key: 'bnb',
        chainId: 56,
        name: 'BNB Chain',
        // Verified against browser-context getLogs (2026-10). Removed:
        // ankr (getLogs requires API key), onfinality/blastapi (429),
        // meowrpc (no getLogs), llamarpc (dead DNS), publicnode (Cloudflare
        // 403s on browser origins despite passing curl).
        rpcUrls: [
            'https://bsc-dataseed.binance.org',
            'https://bsc-dataseed.bnbchain.org',
            'https://rpc-bsc.48.club',
            'https://bsc.drpc.org'
        ],
        explorer: 'https://bscscan.com',
        explorerName: 'BscScan',
        nativeCurrency: { name: 'BNB', symbol: 'BNB', decimals: 18 },
        manifestUrl: './deployment.bnb.json',
        dexscreenerSlug: 'bsc',
        collateral: {
            symbol: 'QQQB',
            shareSymbol: 'stataQQQB',
            decimals: 18,
            shareDecimals: 18,
            name: 'Invesco QQQ (bStocks)',
            address: '0x205812CdBed920aFf76C6580abD681a46D11efc7',
            whatItIs: 'Tokenized Invesco QQQ — tracks the Nasdaq-100 ETF (bStocks)',
            note: 'Securities-linked token; availability varies by jurisdiction.',
        },
        // Where users can get each asset this chain requires.
        // {wsxmr} in a url is replaced with the deployed wsXMR address.
        acquire: {
            gas: [
                { label: 'Buy BNB (Binance)', url: 'https://www.binance.com/en/buy/bnb' },
                { label: 'Swap on PancakeSwap', url: 'https://pancakeswap.finance/swap?chain=bsc&outputCurrency=BNB' },
            ],
            collateral: [
                { label: 'Buy QQQB on PancakeSwap', url: 'https://pancakeswap.finance/swap?chain=bsc&outputCurrency=0x205812CdBed920aFf76C6580abD681a46D11efc7' },
            ],
            wsxmr: [
                { label: 'Buy wsXMR on PancakeSwap', url: 'https://pancakeswap.finance/swap?chain=bsc&outputCurrency={wsxmr}' },
            ],
            // Rough guide: mint needs griefing deposit (vault-set, ~0.001 BNB
            // suggested) plus gas. Displayed in the funding panel.
            gasHint: 'Minting needs BNB for gas plus the vault\'s griefing deposit (~0.001 BNB typical).',
        },
        // RedStone feeds appended to updateOraclePrices calldata.
        // Collateral price is on-chain TWAP — only XMR needs a signed feed.
        redstoneFeeds: ['XMR'],
        blockTimeSec: 0.75,  // BSC ~0.75s blocks
        logChunkSize: 5000   // BSC public RPCs allow ~5k-block getLogs
    },
    base: {
        key: 'base',
        chainId: 8453,
        name: 'Base',
        rpcUrls: [
            'https://mainnet.base.org',
            'https://base.publicnode.com',
            'https://base.llamarpc.com'
        ],
        explorer: 'https://basescan.org',
        explorerName: 'BaseScan',
        nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
        manifestUrl: './deployment.base.json',
        dexscreenerSlug: 'base',
        collateral: {
            symbol: 'cbBTC',
            shareSymbol: 'stataCbBTC',
            decimals: 8,
            shareDecimals: 8,
            name: 'Coinbase Wrapped BTC',
            address: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf',
            whatItIs: 'Coinbase Wrapped BTC — Bitcoin held 1:1 by Coinbase',
            note: null,
        },
        acquire: {
            gas: [
                { label: 'Buy ETH (Coinbase)', url: 'https://www.coinbase.com/how-to-buy/ethereum' },
                { label: 'Bridge to Base', url: 'https://bridge.base.org' },
            ],
            collateral: [
                { label: 'Buy cbBTC on Uniswap', url: 'https://app.uniswap.org/swap?chain=base&outputCurrency=0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf' },
                { label: 'Wrap BTC on Coinbase', url: 'https://www.coinbase.com/cbbtc' },
            ],
            wsxmr: [
                { label: 'Buy wsXMR on Uniswap', url: 'https://app.uniswap.org/swap?chain=base&outputCurrency={wsxmr}' },
            ],
            gasHint: 'Minting needs ETH on Base for gas plus the vault\'s griefing deposit.',
        },
        redstoneFeeds: ['XMR'],
        blockTimeSec: 2,     // Base 2s blocks
        logChunkSize: 9000   // Base public RPCs allow ~10k-block getLogs
    },
    robinhood: {
        key: 'robinhood',
        chainId: 4663,
        name: 'Robinhood Chain',
        rpcUrls: [
            'https://rpc.mainnet.chain.robinhood.com'
        ],
        explorer: 'https://robinhoodchain.blockscout.com',
        explorerName: 'Robinhood Chain Explorer',
        nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
        manifestUrl: './deployment.robinhood.json',
        // DexScreener doesn't index Robinhood Chain — fall back to explorer links.
        dexscreenerSlug: null,
        collateral: {
            symbol: 'SPY',
            shareSymbol: 'stataSPY',
            decimals: 18,
            shareDecimals: 18,
            name: 'SPDR S&P 500 (Robinhood Token)',
            address: '0x117cc2133c37B721F49dE2A7a74833232B3B4C0C',
            whatItIs: 'Robinhood stock token tracking SPDR S&P 500 (RH Assets, Jersey)',
            note: 'Robinhood stock tokens are not offered to US persons — check your jurisdiction.',
        },
        acquire: {
            gas: [
                { label: 'Robinhood Chain bridging', url: 'https://docs.robinhood.com/chain/' },
                { label: 'Bridge via Rift', url: 'https://www.rift.trade' },
            ],
            collateral: [
                { label: 'Buy SPY on Gifted Stock', url: 'https://www.giftedstock.com' },
                { label: 'Swap via Rift', url: 'https://www.rift.trade' },
            ],
            // No hosted Uniswap-style UI indexes this chain yet — the
            // wsXMR/SPY pool exists on-chain but minting is the primary path.
            wsxmr: [],
            gasHint: 'Minting needs ETH bridged to Robinhood Chain for gas plus the vault\'s griefing deposit.',
        },
        redstoneFeeds: ['XMR'],
        blockTimeSec: 0.25,  // Arbitrum Orbit ~250ms blocks
        logChunkSize: 5000   // conservative until RH RPC limits are known
    }
};

// ─── Active chain state ─────────────────────────────────────────────────────

const _manifests = {};          // chainKey -> parsed deployment manifest
let _activeChainKey = null;     // set by setActiveChain() — no default

export function getChainConfig(key) { return CHAINS[key] || null; }
export function getActiveChainKey() { return _activeChainKey; }
export function getActiveChain() { return CHAINS[_activeChainKey] || null; }
export function getDeployment(key) { return _manifests[key] || null; }
export function chainKeyForId(chainId) {
    const id = Number(chainId);
    return Object.keys(CHAINS).find(k => CHAINS[k].chainId === id) || null;
}

/**
 * Fetch (once) and cache a chain's deployment manifest.
 * Returns null when the manifest doesn't exist yet (chain not deployed).
 */
export async function loadDeployment(key) {
    if (!CHAINS[key]) throw new Error(`Unknown chain: ${key}`);
    if (_manifests[key]) return _manifests[key];
    const res = await fetch(CHAINS[key].manifestUrl + '?t=' + Date.now());
    if (!res.ok) return null;
    _manifests[key] = await res.json();
    return _manifests[key];
}

/** True when a chain's manifest is already cached or fetchable. */
export async function isChainDeployed(key) {
    return (await loadDeployment(key)) !== null;
}

// Contract addresses for the ACTIVE chain. Mutated in place by
// setActiveChain() so importers holding the object see live values.
export const CONTRACTS = {
    // Event topic hashes for log parsing (chain-independent)
    MintCancelledWithSecretSig: '0xabfd3b3a7e454869f42e528d99f9f2c2c1ad4aa49c0927059dda28aa4e99093d'
};

function _applyDeployment(key) {
    const D = _manifests[key];
    // Accept both shapes:
    //  - curated:  { contracts: {...}, externalContracts: {...}, pool: {...} }
    //  - raw forge output: flat map of addresses (deploy scripts write this)
    const flat = !D.contracts;
    const DC = flat ? D : D.contracts;
    const DE = flat ? D : (D.externalContracts || {});
    const DP = flat ? { uniswapV3Pool: D.pool } : (D.pool || {});
    const DLC = flat ? {} : (D.lpConfig || {});

    CONTRACTS.hub = DC.wsXmrHub;
    CONTRACTS.wsxmrToken = DC.wsXMR;
    CONTRACTS.liquidityRouter = DC.liquidityRouter;
    // Collateral share token — stataQQQB on BNB, stataCbBTC on Base,
    // stataSPY on Robinhood. Key name kept for call-site compatibility.
    CONTRACTS.stataUSDe = DE.stataQQQB || DE.stataCbBTC || DE.stataSPY || DE.stataUSDe || DE.sDAI || DC.StataUSDe;
    CONTRACTS.uniswapV3Pool = DP.uniswapV3Pool;
    CONTRACTS.nfpm = DE.PancakeV3PositionManager || DE.UniswapV3PositionManager || DE.pcsV3NFPM || DE.uniV3NFPM;
    // Default LP vault to use for mints (the active LP running the LP node)
    CONTRACTS.defaultLpVault = DLC.defaultLpVault;
}

/**
 * Select the active chain. Loads its manifest (first time), repopulates
 * CONTRACTS, and fires 'wrapsynth:chainChanged' so modules can re-render.
 * Throws when the chain isn't deployed yet.
 */
export async function setActiveChain(key) {
    if (!CHAINS[key]) throw new Error(`Unknown chain: ${key}`);
    const manifest = await loadDeployment(key);
    if (!manifest) throw new Error(`Chain ${key} has no deployment manifest yet`);
    _activeChainKey = key;
    _applyDeployment(key);
    window.dispatchEvent(new CustomEvent('wrapsynth:chainChanged', { detail: { chain: key } }));
    return manifest;
}

/**
 * Asset labels for the active chain — use these for all user-visible
 * collateral/gas token strings (e.g. QQQB on BNB, cbBTC on Base, SPY on
 * Robinhood). Fallbacks keep pre-selection renders sane.
 */
export const ASSET = {
    get collateral() { return getActiveChain()?.collateral.symbol ?? 'collateral'; },
    get share() { return getActiveChain()?.collateral.shareSymbol ?? 'shares'; },
    get gas() { return getActiveChain()?.nativeCurrency.symbol ?? 'ETH'; },
};

/** Per-chain localStorage key — keeps swaps/history/preferences isolated. */
export function chainScopedKey(base) {
    return `${base}:${_activeChainKey || 'unchained'}`;
}

/** Explorer URL builders for the active chain. */
export function explorerAddressUrl(address) {
    const c = getActiveChain();
    return c ? `${c.explorer}/address/${address}` : '#';
}
export function explorerTxUrl(txHash) {
    const c = getActiveChain();
    return c ? `${c.explorer}/tx/${txHash}` : '#';
}

// Token decimals
export const DECIMALS = {
    wsXMR: 8,      // EVM wsXMR token decimals
    XMR: 12,       // Monero atomic units decimals
    ETH: 18,       // ETH/HYPE decimals
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
        // Used by the frontend's read-only daemon RPC (height, tx verification).
        // The browser WASM sweep was removed — XMR is claimed by importing keys
        // into a Monero wallet (GUI/Feather, "Restore from keys").
        mainnet: [
            'https://xmr-node.cakewallet.com:18081'
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
    confirmations: 2
};

// Swap parameters
export const SWAP_CONFIG = {
    minMintAmount: 0.01, // Minimum XMR to mint
    minBurnAmount: 0.0001, // Matches contract MIN_BURN_AMOUNT = 1e4 (8 decimals)
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
                { name: 'mintFeeBps', type: 'uint16' },
                { name: 'burnRewardBps', type: 'uint16' },
                { name: 'liquidationNonce', type: 'uint256' },
                { name: 'mintNonce', type: 'uint256' },
                { name: 'minBurnAmount', type: 'uint256' },
                { name: 'active', type: 'bool' },
                { name: 'deployedUSDeShares', type: 'uint256' },
                { name: 'maxCoLPRangeBps', type: 'uint16' },
                { name: 'mintTimeoutBlocks', type: 'uint256' },
                { name: 'burnTimeoutBlocks', type: 'uint256' },
                { name: 'pendingMintCount', type: 'uint256' }
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
                { name: 'userPublicKey', type: 'bytes32' },
                { name: 'timeout', type: 'uint256' },
                { name: 'griefingDeposit', type: 'uint256' },
                { name: 'normalizedDebtAmount', type: 'uint256' },
                { name: 'vaultMintNonce', type: 'uint256' },
                { name: 'lpCommitment', type: 'bytes32' },
                { name: 'revealedSecret', type: 'bytes32' },
                { name: 'status', type: 'uint8' },
                { name: 'lockedCollateral', type: 'uint256' },
                { name: 'xmrPriceAtReady', type: 'uint256' }
            ],
            name: '',
            type: 'tuple'
        }],
        stateMutability: 'view',
        type: 'function'
    },
    getPositionMetadata: {
        inputs: [{ name: 'tokenId', type: 'uint256' }],
        name: 'getPositionMetadata',
        outputs: [{
            components: [
                { name: 'vaultOwner', type: 'address' },
                { name: 'user', type: 'address' },
                { name: 'sDAISharesOriginal', type: 'uint256' },
                { name: 'wsxmrOriginal', type: 'uint256' },
                { name: 'tickLower', type: 'int24' },
                { name: 'tickUpper', type: 'int24' },
                { name: 'liquidity', type: 'uint128' },
                { name: 'createdAt', type: 'uint256' }
            ],
            name: '',
            type: 'tuple'
        }],
        stateMutability: 'view',
        type: 'function'
    },
    getUserPositions: {
        inputs: [{ name: 'user', type: 'address' }],
        name: 'getUserPositions',
        outputs: [{ name: '', type: 'uint256[]' }],
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
                { name: 'status', type: 'uint8' },
                { name: 'userClaimCommitment', type: 'bytes32' },
                { name: 'userPublicKey', type: 'bytes32' },
                { name: 'userViewKey', type: 'bytes32' },
                { name: 'xmrPriceAtRequest', type: 'uint256' },
                { name: 'revealedSecret', type: 'bytes32' }
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
        'function provideLPKey(bytes32 requestId, bytes32 lpPublicSpendKey, bytes32 lpPublicViewKey, bytes32 lpCommitment) external',
        'function setMintReady(bytes32 requestId) external',
        'function revealSecret(bytes32 requestId, bytes32 secret) external',
        'function finalizeMint(bytes32 requestId) external',
        'function cancelMint(bytes32 requestId, bytes32 userSecret) external',
        'function claimGriefingDeposit(bytes32 requestId, bytes32 lpSecret) external',
        'function sweepUnclaimedExpiredMint(bytes32 requestId) external',
        'function abandonKeyProvidedMint(bytes32 requestId, bytes32 lpSecret) external',
        'function reclaimParkedDeposit(bytes32 requestId) external',
        'function abandonProposedBurn(bytes32 requestId) external',
        'function lpPublicKeys(bytes32 requestId) external view returns (bytes32)',
        'function lpPublicViewKeys(bytes32 requestId) external view returns (bytes32)',
        'function burnLpPublicKeys(bytes32 requestId) external view returns (bytes32)',
        'function burnLpPublicViewKeys(bytes32 requestId) external view returns (bytes32)',
        'function getUserMintRequests(address user) external view returns (bytes32[])',
        'function getVaultPendingMints(address lpVault) external view returns (bytes32[])',
        'function calculateWsxmrAmount(uint256 xmrAmount) external pure returns (uint256)',
        'function calculateMintFee(address lpVault, uint256 wsxmrAmount) external view returns (uint256)',
        'function calculateBurnCollateral(address lpVault, uint256 wsxmrAmount) external view returns (uint256 baseLock, uint256 rewardLock)',

        // Burn flow — 4-step: requestBurn → proposeHash → confirmMoneroLock → finalizeBurn
        'function requestBurn(uint256 wsxmrAmount, address lpVault, address user, bytes32 claimCommitment, bytes32 userPublicKey, bytes32 userViewKey) external returns (bytes32 requestId)',
        'function proposeHash(bytes32 requestId, bytes32 secretHash, bytes32 lpPublicSpendKey, bytes32 lpPublicViewKey) external',
        'function confirmMoneroLock(bytes32 requestId) external',
        'function finalizeBurn(bytes32 requestId, bytes32 secret) external',
        'function revealBurnSecret(bytes32 requestId, bytes32 secret) external',
        'function settleBurn(bytes32 requestId) external',
        'function claimSlashedCollateral(bytes32 requestId) external',
        'function cancelBurn(bytes32 requestId) external',
        'function getUserBurnRequests(address user) external view returns (bytes32[])',
        'function getVaultBurnRequests(address vault) external view returns (bytes32[])',

        // Vault (LP-side)
        'function createVault() external',
        'function deactivateVault() external',
        'function depositCollateral(uint256 amount) external',
        'function depositShares(uint256 shares) external',
        'function withdrawCollateral(uint256 shares) external',
        'function setMintGriefingDeposit(uint256 deposit) external',
        'function setVaultMarketMetrics(uint16 mintFeeBps, uint16 burnRewardBps) external',
        'function setMaxMintBps(uint16 maxMintBps) external',
        'function setMinBurnAmount(uint256 minAmount) external',
        'function withdrawReturns(address token) external',
        'function getVaultHealth(address lpAddress) external view returns (uint256 ratio)',
        'function getVaultDebt(address lpAddress) external view returns (uint256)',
        'function getMintCapacity(address lpVault) external view returns (uint256 maxWsxmrAmount)',
        'function getVaultCount() external view returns (uint256)',
        'function vaultList(uint256 index) external view returns (address)',
        'function getPendingReturns(address user, address token) external view returns (uint256)',
        'function hasActiveVault(address lpAddress) external view returns (bool)',

        // Co-LP operations
        'function userOpenCoLP(address lpVault, uint256 wsxmrAmount, uint256 deadline) external returns (uint256 tokenId)',
        'function unwindCoLP(uint256 tokenId, uint256 deadline) external',
        'function collectCoLPFees(uint256 tokenId) external',
        'function rebalanceCoLP(uint256 tokenId, uint16 newRangeBps, uint256 deadline) external',
        'function getCoLPCapacity(address lpVault) external view returns (uint256 maxWsxmrAcceptable)',
        'function getUserPositions(address user) external view returns (uint256[])',
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
        'function lastXmrPrice() external view returns (int192)',
        'function lastCollateralPrice() external view returns (int192)',
        'function globalDebtIndex() external view returns (uint256)',
        'function xmrEmaPrice() external view returns (uint256)',

        // Events
        'event MintInitiated(bytes32 indexed requestId, address indexed initiator, address indexed recipient, address lpVault, uint256 xmrAmount, uint256 wsxmrAmount, uint256 feeAmount, bytes32 claimCommitment, bytes32 userPublicKey, uint256 timeout)',
        'event LPKeyProvided(bytes32 indexed requestId, bytes32 lpPublicSpendKey, bytes32 lpPublicViewKey)',
        'event MintReady(bytes32 indexed requestId, bytes32 lpCommitment)',
        'event MintFinalized(bytes32 indexed requestId, bytes32 secret)',
        'event MintCancelled(bytes32 indexed requestId)',
        'event MintCancelledWithSecret(bytes32 indexed requestId, bytes32 userSecret)',
        'event MintExpiredReady(bytes32 indexed requestId)',
        'event MintCollateralLocked(bytes32 indexed requestId, uint256 lockedCollateral)',
        'event GriefingDepositClaimed(bytes32 indexed requestId, bytes32 lpSecret)',
        'event MintCollateralSlashed(bytes32 indexed requestId, uint256 slashedCollateral)',
        'event BurnRequested(bytes32 indexed requestId, address indexed user, address indexed lpVault, uint256 wsxmrAmount, uint256 xmrAmount, uint256 rewardCollateral, bytes32 claimCommitment, bytes32 userPublicKey, bytes32 userViewKey)',
        'event HashProposed(bytes32 indexed requestId, bytes32 secretHash, bytes32 lpPublicSpendKey, bytes32 lpPublicViewKey)',
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
        'function allocateLiquidity(uint256 usdeAmount) external',
        'function withdrawUSDe(uint256 usdeAmount) external',
        'function increaseUserApproval(address user, uint256 additionalUSDe) external',
        'function decreaseUserApproval(address user, uint256 reduceUSDe) external',
        // User side
        'function depositWsxmr(uint256 amount) external',
        'function withdrawWsXMR(uint256 wsxmrAmount) external',
        'function increaseLpApproval(address lp, uint256 additionalWsxmr) external',
        'function decreaseLpApproval(address lp, uint256 reduceWsxmr) external',
        'function burnFromInternalBalance(uint256 wsxmrAmount, address lpVault) external returns (bytes32)',
        // Positions
        'function createPosition(address lp, address user, uint256 usdeAmount, uint256 wsxmrAmount, uint256 deadline) external returns (uint256)',
        'function createPositionWithPriceUpdate(address lp, address user, uint256 usdeAmount, uint256 wsxmrAmount, uint256 deadline, bytes[] calldata oracleUpdateData) external payable returns (uint256)',
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
        'event PositionCreated(uint256 indexed positionIndex, uint256 dexTokenId, address indexed lp, address indexed user, uint256 usdeAmount, uint256 wsxmrAmount)',
        'event PositionClosed(uint256 indexed positionIndex, uint256 usdeReturned, uint256 wsxmrReturned)',
        'event LpApprovedUser(address indexed lp, address indexed user, uint256 amount)',
        'event UserApprovedLp(address indexed user, address indexed lp, uint256 amount)',
        'event ILSUSDeCredited(address indexed user, uint256 amount, uint256 positionIndex)',
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
