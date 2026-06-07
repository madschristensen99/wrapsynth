const fs = require('fs');
const path = require('path');

// Read deployment configuration
const deploymentPath = path.join(__dirname, '../deployments/gnosis-mainnet-deployment.json');
const deployment = JSON.parse(fs.readFileSync(deploymentPath, 'utf8'));

module.exports = {
    HUB_ADDRESS: deployment.contracts.wsXmrHub,
    WSXMR_ADDRESS: deployment.contracts.wsXMR,
    LIQUIDITY_ROUTER: deployment.contracts.liquidityRouter,
    POOL_ADDRESS: deployment.contracts.uniswapV3Pool,
    SDAI_ADDRESS: deployment.externalContracts.sDAI,
    WXDAI_ADDRESS: '0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d',
    ED25519_HELPER: '0x7EBdE733CE8Bac20984f919e4d2E66e9eE86f2a3',
    UNI_V3_FACTORY: '0xe32F7dD7e3f098D518ff19A22d5f028e076489B1',
    UNI_V3_POSITION_MANAGER: '0xAE8fbE656a77519a7490054274910129c9244FA3',
    SWAP_ROUTER: '0xE592427A0AEce92De3Edee1F18E0157C05861564', // Uniswap V3 SwapRouter
    
    // Facets
    ORACLE_FACET: deployment.contracts.facets.RedStoneOracleFacet,
    VAULT_FACET: deployment.contracts.facets.VaultFacet,
    MINT_FACET: deployment.contracts.facets.MintFacet,
    BURN_FACET: deployment.contracts.facets.BurnFacet,
    LIQUIDATION_FACET: deployment.contracts.facets.LiquidationFacet,
    YIELD_FACET: deployment.contracts.facets.YieldFacet,
    
    // Metadata
    DEPLOYMENT_DATE: deployment.deploymentDate,
    DEPLOYER: deployment.deployer,
    NOTE: deployment.note
};
