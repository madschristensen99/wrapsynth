// ============================================
// WrapSynth Configuration
// ============================================

// Network configurations
export const NETWORKS = {
    GNOSIS: {
        id: 100,
        name: 'Gnosis Chain',
        network: 'gnosis',
        nativeCurrency: {
            decimals: 18,
            name: 'xDAI',
            symbol: 'xDAI',
        },
        rpcUrls: {
            default: {
                http: ['https://rpc.gnosischain.com'],
            },
            public: {
                http: ['https://rpc.gnosischain.com'],
            },
        },
        blockExplorers: {
            default: {
                name: 'Gnosisscan',
                url: 'https://gnosisscan.io',
            },
        },
    },
    UNICHAIN_SEPOLIA: {
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
    },
};

// Contract deployments per network
export const DEPLOYMENTS = {
    GNOSIS: {
        chainId: 100,
        wrappedMonero: '0x8890f651190c838651623de077474a98e37803ab',
        wsXmrHub: '0xd32e2ece901094550b81ab5051a72256761514d6',
        oracleFacet: '0x01acec458fd3e8508510cbdc03a8f64532a10618',
        vaultFacet: '0xf2ec5240c442bba6674a873343ec43c451467229',
        mintFacet: '0x35da334de761b200da3242429b884a00509bc32b',
        burnFacet: '0x779e5a10f4ba60fbc87c1dee79f09168547fda09',
        liquidationFacet: '0xbc5ffaaa057030b5e6b1f13807f54fd029c57c94',
        yieldFacet: '0x6d242f08ec7d704b5824f1334c192360f2966add',
        liquidityRouter: '0x3235ffe7b51b3726bc0f398da21ed0583103f106',
        sDAI: '0xaf204776c7245bF4147c2612BF6e5972Ee483701', // Savings DAI on Gnosis
        wxDAI: '0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d', // Wrapped xDAI
        pythOracle: '0x2880aB155794e7179c9eE2e38200202908C17B43',
        ed25519Helper: '0x7EBdE733CE8Bac20984f919e4d2E66e9eE86f2a3',
        initialMoneroBlock: 3607954,
        deployedAt: '2026-06-03T21:00:00.000Z',
    },
    UNICHAIN_SEPOLIA: {
        chainId: 1301,
        wrappedMonero: '0xC67Cf54d14078ff2968b4Fcd55331C48CEf69eeF',
        plonkVerifier: '0x...', // Add when deployed
        sDAI: '0xc02fe7317d4eb8753a02c35fe019786854a92001', // Placeholder for testnet
        pythOracle: '0x2880aB155794e7179c9eE2e38200202908C17B43',
        initialMoneroBlock: 3605079,
        deployedAt: null,
    },
};

// Default network (Gnosis mainnet)
export const DEFAULT_NETWORK = 'GNOSIS';

// Get configuration for a specific network
export function getNetworkConfig(networkKey = DEFAULT_NETWORK) {
    const network = NETWORKS[networkKey];
    const deployment = DEPLOYMENTS[networkKey];
    
    if (!network || !deployment) {
        throw new Error(`Network ${networkKey} not found in configuration`);
    }
    
    return {
        ...network,
        contracts: deployment,
        chainId: network.id,
        rpcUrl: network.rpcUrls.default.http[0],
        explorerUrl: network.blockExplorers.default.url,
    };
}

// Get configuration by chain ID
export function getConfigByChainId(chainId) {
    const networkKey = Object.keys(DEPLOYMENTS).find(
        key => DEPLOYMENTS[key].chainId === chainId
    );
    
    if (!networkKey) {
        throw new Error(`No configuration found for chain ID ${chainId}`);
    }
    
    return getNetworkConfig(networkKey);
}

// Monero configuration
export const MONERO_CONFIG = {
    PICONERO_PER_XMR: 1e12,
    RPC_URL: 'https://xmr.privex.io:18081',
    STAGENET_RPC_URL: 'http://stagenet.xmr-tw.org:38081',
};

// Application configuration
export const APP_CONFIG = {
    APP_NAME: 'WrapSynth',
    APP_VERSION: '1.0.0',
    WEBSITE_URL: 'https://wrapsynth.com',
    GITHUB_URL: 'https://github.com/madschristensen99/wrapsynth',
    DOCS_URL: 'https://docs.wrapsynth.com',
    
    // Feature flags
    FEATURES: {
        PRIVATE_MINTING: true,
        LP_SYSTEM: true,
        UNISWAP_HOOKS: false, // Not yet deployed
    },
    
    // UI Configuration
    UI: {
        THEME: 'dark',
        SHOW_TESTNET_WARNING: false, // Set to true for testnets
    },
};

// Export a simple CONFIG object for backward compatibility
export const CONFIG = {
    ...getNetworkConfig(DEFAULT_NETWORK),
    PICONERO_PER_XMR: MONERO_CONFIG.PICONERO_PER_XMR,
    CONTRACT_ADDRESS: DEPLOYMENTS[DEFAULT_NETWORK].wrappedMonero,
    CHAIN_ID: NETWORKS[DEFAULT_NETWORK].id,
    RPC_URL: NETWORKS[DEFAULT_NETWORK].rpcUrls.default.http[0],
    EXPLORER_URL: NETWORKS[DEFAULT_NETWORK].blockExplorers.default.url,
};

// Helper function to switch networks
export function switchNetwork(networkKey) {
    const config = getNetworkConfig(networkKey);
    return {
        chainId: config.chainId,
        chainName: config.name,
        nativeCurrency: config.nativeCurrency,
        rpcUrls: config.rpcUrls.default.http,
        blockExplorerUrls: [config.explorerUrl],
    };
}

// Export all for convenience
export default {
    NETWORKS,
    DEPLOYMENTS,
    DEFAULT_NETWORK,
    MONERO_CONFIG,
    APP_CONFIG,
    CONFIG,
    getNetworkConfig,
    getConfigByChainId,
    switchNetwork,
};
