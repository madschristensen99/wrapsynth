// ============================================
// WrapSynth Configuration
// ============================================
// Contract addresses are loaded from the canonical root deployment.json (window.DEPLOYMENT).

const D = window.DEPLOYMENT || {};
const DC = D.contracts || {};
const DF = DC.facets || {};
const DE = D.externalContracts || {};

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
                http: [
                    'https://rpc.ankr.com/gnosis',
                    'https://gnosis.api.onfinality.io/public',
                    'https://rpc.gnosis.gateway.fm'
                ],
            },
            public: {
                http: [
                    'https://rpc.ankr.com/gnosis',
                    'https://gnosis.api.onfinality.io/public',
                    'https://rpc.gnosis.gateway.fm'
                ],
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
        wrappedMonero: DC.wsXMR || '0x1fab9db7aeb79a71278b1348acdf55ef55292010',
        wsXmrHub: DC.wsXmrHub || '0xbf24788234512bb0aa10451f6efa88ca0e31d88e',
        oracleFacet: DF.RedStoneOracleFacet || '0xa533cb055527ff3f8cfc3f3f2902fd0d208c20a2',
        vaultFacet: DF.VaultFacet || '0xcf8d4a0f5cf7abe725ccc2f765fc1c21798a0b99',
        mintFacet: DF.MintFacet || '0x8b96fce0f6a8d1bc67829310d9513f9968b51041',
        burnFacet: DF.BurnFacet || '0x0fff27bf5645a9948a02aac65a170782baa45c78',
        liquidationFacet: DF.LiquidationFacet || '0x7c3f2773a5a280604689a621b8bbaf2d92f77d96',
        yieldFacet: DF.YieldFacet || '0x2c73826c36895f7fff9839fe58d3ab164a206721',
        liquidityRouter: DC.liquidityRouter || '0x69ab32e9df71333fc3e6c526ef8cb9ea4cfa9a63',
        sDAI: DE.sDAI || '0xaf204776c7245bF4147c2612BF6e5972Ee483701',
        pythOracle: DE.PythOracle || '0x2880aB155794e7179c9eE2e38200202908C17B43',
        ed25519Helper: DE.Ed25519Helper || '0xaECa36374039EAb9e267B5daa48bAb9Ab0e50F00',
        initialMoneroBlock: 3607954,
        deployedAt: D.deploymentDate || '2026-06-10T00:00:00.000Z',
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
