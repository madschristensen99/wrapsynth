const fs = require('fs');
const path = require('path');

// HyperEVM deployment manifest written by script/DeployHyperEVM.s.sol
const deploymentPath = path.join(__dirname, '../deployments/hyperevm-deployment.json');
const deployment = JSON.parse(fs.readFileSync(deploymentPath, 'utf8'));

module.exports = {
    // Core
    HUB_ADDRESS: deployment.wsXmrHub,
    WSXMR_ADDRESS: deployment.wsXMR,
    LIQUIDITY_ROUTER: deployment.liquidityRouter,
    POOL_ADDRESS: deployment.pool,

    // Collateral: USDe is the underlying; stataUSDe is the vault share token
    USDE_ADDRESS: deployment.usde,
    STATA_USDE_ADDRESS: deployment.stataUSDe,

    // Helpers deployed alongside the stack
    ED25519_HELPER: deployment.ed25519Helper,
    SWAP_HELPER: deployment.swapHelper,

    // HyperSwap venue
    HYPERSWAP_FACTORY: deployment.hyperswapFactory,
    HYPERSWAP_ROUTER: deployment.hyperswapRouter,
    HYPERSWAP_NFPM: deployment.hyperswapNFPM,

    // HyperLend
    HYPERLEND_POOL: deployment.hyperlendPool,
    HYPERLEND_ATOKEN: deployment.hyperlendAToken,

    // Facets
    ORACLE_FACET: deployment.oracleFacet,
    VAULT_FACET: deployment.vaultFacet,
    MINT_FACET: deployment.mintFacet,
    BURN_FACET: deployment.burnFacet,
    LIQUIDATION_FACET: deployment.liquidationFacet,
    YIELD_FACET: deployment.yieldFacet,

    // Metadata
    XMR_PERP_INDEX: deployment.xmrPerpIndex,
    DEPLOYER: deployment.deployer,
    CHAIN_ID: 999,
    RPC_URL: process.env.HYPEREVM_RPC_URL || 'https://rpc.hyperliquid.xyz/evm',
    EXPLORER: 'https://hyperevmscan.io'
};
