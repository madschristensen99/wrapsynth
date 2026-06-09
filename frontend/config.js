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
        wrappedMonero: DC.wsXMR || '0xf1AfA7DFF4F5feFba2c3C3D0e0e4BADeE2681225',
        wsXmrHub: DC.wsXmrHub || '0xc75a388ce5d04a3831733937e8CaEc6e23bC24c4',
        oracleFacet: DF.RedStoneOracleFacet || '0xCbE66353a44ffe0ab97Fc211a49a9c6efC0b2707',
        vaultFacet: DF.VaultFacet || '0x80dF75a0999619E51aEA40E9484c7Aea7Cf19F5C',
        mintFacet: DF.MintFacet || '0x52c5C8E817dF71788DD6bDe69C748F5868f2250a',
        burnFacet: DF.BurnFacet || '0x2CA8CFFC50320A2c13A9e02807Db291Cfb654604',
        liquidationFacet: DF.LiquidationFacet || '0xc9c9C664A5757bF6bb7A4fb2EC885Ff83541e596',
        yieldFacet: DF.YieldFacet || '0x035B50d75458C309B750bb7b4a2778b761E142C3',
        liquidityRouter: DC.liquidityRouter || '0x0D1CF3C6F0F71b99AB02049a46fbeBF7c3BFFf97',
        sDAI: DE.sDAI || '0xaf204776c7245bF4147c2612BF6e5972Ee483701',
        wxDAI: DE.wxDAI || '0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d',
        pythOracle: DE.PythOracle || '0x2880aB155794e7179c9eE2e38200202908C17B43',
        ed25519Helper: DE.Ed25519Helper || '0x7EBdE733CE8Bac20984f919e4d2E66e9eE86f2a3',
        initialMoneroBlock: 3607954,
        deployedAt: D.deploymentDate || '2026-06-09T00:00:00.000Z',
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
