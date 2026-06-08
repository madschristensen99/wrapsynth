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
        wrappedMonero: '0x48AAec97bD8ccB3bDE02D492929712f071E710eb',
        wsXmrHub: '0x025B1499B5f4E51a0053aB1742B2Ecd545615e5a',
        oracleFacet: '0xb3100e342ED58779CAFa1456174CfB2C00B8A2f1',
        vaultFacet: '0xD4db0241e706D5ED966F15474E1Bb19Be303Ee79',
        mintFacet: '0x792c52F3E0208b90A60A4188f711f4Bc1ED45634',
        burnFacet: '0xe229AEcCf13687e5AAa890F6d8991ddEbDa66417',
        liquidationFacet: '0x7196fB6da654D0E63Ffc628Ce8E5B4501eE7Ea0c',
        yieldFacet: '0x1068D8B354F9C53e7ba932882E9898010fE32730',
        liquidityRouter: '0xEE5F9dd5F6736b556ee306467e9aE295a7fd0de5',
        sDAI: '0xaf204776c7245bF4147c2612BF6e5972Ee483701', // Savings DAI on Gnosis
        wxDAI: '0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d', // Wrapped xDAI
        pythOracle: '0x2880aB155794e7179c9eE2e38200202908C17B43',
        ed25519Helper: '0x7EBdE733CE8Bac20984f919e4d2E66e9eE86f2a3',
        initialMoneroBlock: 3607954,
        deployedAt: '2026-06-06T00:00:00.000Z',
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
