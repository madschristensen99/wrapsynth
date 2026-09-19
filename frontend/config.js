// ============================================
// Wrapsynth Configuration
// ============================================
// Contract addresses are loaded from the canonical root deployment.json (window.DEPLOYMENT).

const D = window.DEPLOYMENT || {};
const DC = D.contracts || {};
const DF = DC.facets || {};
const DE = D.externalContracts || {};

// Network configurations
export const NETWORKS = {
    HYPEREVM: {
        id: 999,
        name: 'HyperEVM',
        network: 'hyperevm',
        nativeCurrency: {
            decimals: 18,
            name: 'HYPE',
            symbol: 'HYPE',
        },
        rpcUrls: {
            default: {
                http: ['https://rpc.hyperliquid.xyz/evm'],
            },
            public: {
                http: ['https://rpc.hyperliquid.xyz/evm'],
            },
        },
        blockExplorers: {
            default: {
                name: 'HyperEVM Scan',
                url: 'https://hyperevmscan.io',
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
    HYPEREVM: {
        chainId: 999,
        wrappedMonero: DC.wsXMR,
        wsXmrHub: DC.wsXmrHub,
        oracleFacet: DF.HyperCoreOracleFacet,
        vaultFacet: DF.VaultFacet,
        mintFacet: DF.MintFacet,
        burnFacet: DF.BurnFacet,
        liquidationFacet: DF.LiquidationFacet,
        yieldFacet: DF.YieldFacet,
        liquidityRouter: DC.liquidityRouter,
        sDAI: DE.sDAI,
        ed25519Helper: DE.Ed25519Helper,
        initialMoneroBlock: 3607954,
        deployedAt: D.deploymentDate,
    },
    UNICHAIN_SEPOLIA: {
        chainId: 1301,
        wrappedMonero: '0xC67Cf54d14078ff2968b4Fcd55331C48CEf69eeF',
        plonkVerifier: '0x...', // Add when deployed
        sDAI: '0xc02fe7317d4eb8753a02c35fe019786854a92001', // Placeholder for testnet
        initialMoneroBlock: 3605079,
        deployedAt: null,
    },
};

// Default network (HyperEVM mainnet)
export const DEFAULT_NETWORK = 'HYPEREVM';

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
    APP_NAME: 'Wrapsynth',
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
