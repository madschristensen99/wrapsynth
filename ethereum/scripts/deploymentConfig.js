const fs = require('fs');
const path = require('path');

// Read canonical deployment configuration from project root (single source of truth)
const deploymentPath = path.join(__dirname, '../../deployment.json');
const deployment = JSON.parse(fs.readFileSync(deploymentPath, 'utf8'));

module.exports = {
    HUB_ADDRESS: deployment.contracts.wsXmrHub,
    WSXMR_ADDRESS: deployment.contracts.wsXMR,
    LIQUIDITY_ROUTER: deployment.contracts.liquidityRouter,
    POOL_ADDRESS: deployment.pool.uniswapV3Pool,
    SDAI_ADDRESS: deployment.externalContracts.sDAI,
    WXDAI_ADDRESS: deployment.externalContracts.wxDAI,
    ED25519_HELPER: deployment.externalContracts.Ed25519Helper,
    UNI_V3_FACTORY: deployment.externalContracts.UniswapV3Factory,
    UNI_V3_POSITION_MANAGER: deployment.externalContracts.UniswapV3PositionManager,
    SWAP_HELPER: deployment.externalContracts.SwapHelper,
    SWAP_ROUTER: '0xc6D25285D5C5b62b7ca26D6092751A145D50e9Be', // Uniswap V3 SwapRouter on Gnosis Chain

    // Facets
    ORACLE_FACET: deployment.contracts.facets.RedStoneOracleFacet,
    VAULT_FACET: deployment.contracts.facets.VaultFacet,
    MINT_FACET: deployment.contracts.facets.MintFacet,
    BURN_FACET: deployment.contracts.facets.BurnFacet,
    LIQUIDATION_FACET: deployment.contracts.facets.LiquidationFacet,
    YIELD_FACET: deployment.contracts.facets.YieldFacet,

    // Metadata
    DEPLOYMENT_DATE: deployment.deploymentDate,
    CHAIN_ID: deployment.chainId,
    RPC_URL: deployment.rpcUrl,
    EXPLORER: deployment.explorer
};
