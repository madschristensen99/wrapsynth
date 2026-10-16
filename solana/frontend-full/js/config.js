// Configuration for Phantom Agent — Solana devnet edition.
// Addresses are loaded from devnet-config.json (window.DEPLOYMENT).

// The HTML loader sets window.DEPLOYMENT, but module evaluation can race it.
// Top-level await guarantees every importer reads a populated manifest.
if (!window.DEPLOYMENT) {
    try {
        const res = await fetch('./devnet-config.json?t=' + Date.now());
        if (res.ok) window.DEPLOYMENT = await res.json();
        else console.error('config.js: devnet-config.json returned ' + res.status);
    } catch (e) {
        console.error('config.js: failed to load devnet-config.json', e);
    }
}

const D = window.DEPLOYMENT || {};
const ORACLE = D.oracle || {};
const LP_SERVER_URL = window.LP_SERVER_URL || 'http://localhost:3002';

// Probe the LP server for the vault it services — mints must target its vault
// or they'll sit pending forever. Fails fast if the server isn't running.
let lpServerVault = null;
try {
    const h = await Promise.race([
        fetch(LP_SERVER_URL + '/health').then(r => r.json()),
        new Promise((_, rej) => setTimeout(() => rej(new Error('lp probe timeout')), 2000)),
    ]);
    lpServerVault = h.vault || null;
} catch (e) { console.warn('config.js: lp-server probe failed —', e.message); }

export const NETWORKS = {
    solanaDevnet: {
        id: 'devnet',
        name: 'Solana Devnet',
        rpcUrls: [D.rpc || 'https://api.devnet.solana.com'],
        blockExplorer: 'https://solscan.io',
        nativeCurrency: { name: 'SOL', symbol: 'SOL', decimals: 9 }
    },
    // Alias kept so `NETWORKS.hyperevm` references in modules resolve.
    hyperevm: null
};
NETWORKS.hyperevm = NETWORKS.solanaDevnet;

// Contract addresses — Solana program/PDAs/mints mapped onto the EVM names
// the UI modules already read.
export const CONTRACTS = {
    hub: D.programId,                      // wrapsynth vault-manager program
    programId: D.programId,
    wsxmrToken: D.wsxmrMint,               // wsXMR SPL mint (Token-2022)
    stataUSDe: D.collateralMint,           // wSOL mint — SPL identity of native SOL collateral
    globalState: D.globalState,
    programCollateralAta: D.collateralEscrow ?? D.programCollateralAta,
    collateralEscrow: D.collateralEscrow,
    solEscrow: D.solEscrow,
    pythXmr: ORACLE.xmr,
    pythCollateral: ORACLE.sol ?? ORACLE.qqqx,
    oracleMockProgram: D.oracleMockProgramId,
    // Vault serviced by the running LP server — the only vault users should mint against.
    defaultLpVault: lpServerVault,
    lpServerUrl: LP_SERVER_URL,
    // EVM-only — unused on Solana but imported by modules.
    liquidityRouter: null,
    uniswapV3Pool: null,
    nfpm: null,
    MintCancelledWithSecretSig: null,
};

// Token decimals — identical to the Solana deployment.
export const DECIMALS = {
    wsXMR: 8,      // wsXMR SPL decimals
    XMR: 12,       // Monero atomic units decimals
    ETH: 9,        // SOL lamports decimals (native-balance displays)
    USD: 18,       // oracle prices scaled to 1e18 on-chain
    COLLATERAL: 9  // native SOL decimals
};

// Monero Network Configuration — stagenet for devnet testing.
export const MONERO_CONFIG = {
    rpcUrl: 'http://stagenet.xmr-tw.org:38081',
    networkType: 'stagenet',
    publicNodes: {
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
    refreshInterval: 10000,
    confirmations: 2
};

// Swap parameters
export const SWAP_CONFIG = {
    minMintAmount: 0.01,
    minBurnAmount: 0.01,    // Solana program MIN_BURN_AMOUNT = 1_000_000 (0.01 wsXMR)
    defaultTimeout: 7200,   // 2 hours in seconds (matches MAX_MINT_TIMEOUT)
    pollInterval: 5000,
    maxRetries: 3
};

// Storage keys for localStorage
export const STORAGE_KEYS = {
    activeSwap: 'phantom_active_swap',
    swapHistory: 'phantom_swap_history',
    userPreferences: 'phantom_preferences'
};

// EVM struct layouts — kept for reference by readHub's shape mapping.
export const RAW_ABIS = {};

// Minimal ABI stubs — imported by modules for EVM-only paths (encodeFunctionData
// on pool/co-LP calls). On Solana those paths are gated off; the strings only
// need to exist so parseAbi() doesn't crash.
export const ABIS = {
    hub: ['function noop()'],
    wsxmr: [
        'function transfer(address to, uint256 value) returns (bool)',
        'function balanceOf(address) view returns (uint256)',
        'function allowance(address,address) view returns (uint256)',
        'function approve(address,uint256) returns (bool)',
        'event Transfer(address indexed from, address indexed to, uint256 value)',
    ],
    liquidityRouter: ['function noop()'],
};

export const MESSAGE_PREFIX = 'Phantom Agent Swap Authorization';

// LP server REST base (used by mint/burn flows for deposit-address + status).
export const LP_API = LP_SERVER_URL;
