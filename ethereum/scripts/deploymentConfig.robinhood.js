const fs = require('fs');
const path = require('path');

// Robinhood Chain deployment manifest (mirrors frontend/deployment.robinhood.json)
const deploymentPath = path.join(__dirname, '../../frontend/deployment.robinhood.json');
const deployment = JSON.parse(fs.readFileSync(deploymentPath, 'utf8'));

module.exports = {
    HUB_ADDRESS: deployment.wsXmrHub,
    WSXMR_ADDRESS: deployment.wsXMR,
    LIQUIDITY_ROUTER: deployment.liquidityRouter,
    POOL_ADDRESS: deployment.pool,
    STATA_ADDRESS: deployment.stataSPY,            // collateral share token
    QQQB_ADDRESS: deployment.spy,                  // underlying collateral token (SPY)
    WETH_ADDRESS: deployment.weth,
    USDG_ADDRESS: deployment.usdg,
    ED25519_HELPER: process.env.ED25519_HELPER || deployment.ed25519Helper,
    UNI_V3_FACTORY: deployment.uniV3Factory,
    UNI_V3_POSITION_MANAGER: deployment.uniV3NFPM,
    UNI_SWAP_ROUTER: deployment.uniSwapRouter,
    SWAP_HELPER: process.env.SWAP_HELPER || deployment.swapHelper,
    POOL_FEE: 500,                                  // wsXMR/SPY V3 fee tier
    SPY_USDG_POOL: deployment.spyUsdgPool,
    RPC_URL: process.env.ROBINHOOD_RPC_URL || 'https://rpc.mainnet.chain.robinhood.com',
    EXPLORER: 'https://robin.etherscan.io',
};
