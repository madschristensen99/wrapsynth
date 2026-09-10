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
                    'https://rpc.gnosischain.com',
                    'https://gnosis-rpc.publicnode.com',
                    'https://rpc.gnosis.gateway.fm'
                ],
            },
            public: {
                http: [
                    'https://rpc.gnosischain.com',
                    'https://gnosis-rpc.publicnode.com',
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
        wrappedMonero: DC.wsXMR || '0x8197d472823CC8BB5ae4077619bC85cAD19C4A5f',
        wsXmrHub: DC.wsXmrHub || '0x29BF76f72694A99e5C1483871aD62f87501fC99E',
        oracleFacet: DF.RedStoneOracleFacet || '0x6fE6e9CE3e385541FBAe77E47c10e2948939c6a2',
        vaultFacet: DF.VaultFacet || '0xfb7E1d0B239E8B1C02b20CCEA283927C293B0519',
        mintFacet: DF.MintFacet || '0x9a0c5bD186Fe4dbb673C2bc3df41b40329D0aCeC',
        burnFacet: DF.BurnFacet || '0x2ca92dce1223B47088198F9AB7e505a097e8E6cC',
        liquidationFacet: DF.LiquidationFacet || '0x4d8dB172f94b49f99332e0E956dd26796c55Ee7D',
        yieldFacet: DF.YieldFacet || '0x73aa804A2fEc43f79eC66a8daF36a806e83Ce1BD',
        liquidityRouter: DC.liquidityRouter || '0x52EcC68d3E38c86778e940A9fCeAB1e19f92F59e',
        sDAI: DE.sDAI || '0xaf204776c7245bF4147c2612BF6e5972Ee483701',
        ed25519Helper: DE.Ed25519Helper || '0xaECa36374039EAb9e267B5daa48bAb9Ab0e50F00',
        initialMoneroBlock: 3607954,
        deployedAt: D.deploymentDate || '2026-08-18T14:18:00.000Z',
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
