const fs = require('fs');
const path = require('path');

// Base deployment manifest (mirrors frontend/deployment.base.json)
const deploymentPath = path.join(__dirname, '../deployments/base-deployment.json');
const deployment = JSON.parse(fs.readFileSync(deploymentPath, 'utf8'));

module.exports = {
    HUB_ADDRESS: deployment.wsXmrHub,
    WSXMR_ADDRESS: deployment.wsXMR,
    LIQUIDITY_ROUTER: deployment.liquidityRouter,
    POOL_ADDRESS: deployment.pool,
    STATA_ADDRESS: deployment.stataCbBTC,          // collateral share token
    QQQB_ADDRESS: deployment.cbbtc,                // underlying collateral token (cbBTC)
    WETH_ADDRESS: deployment.weth,
    USDC_ADDRESS: deployment.usdc,
    ED25519_HELPER: process.env.ED25519_HELPER || '0xA1b9115450c3e3dCAD11c04Cf9Bf4092335B3A64',
    UNI_V3_FACTORY: deployment.uniV3Factory,
    UNI_V3_POSITION_MANAGER: deployment.uniV3NFPM,
    UNI_SWAP_ROUTER: deployment.uniSwapRouter,
    UNI_V3_QUOTER_V2: deployment.uniV3QuoterV2,
    SWAP_HELPER: process.env.SWAP_HELPER || '0x313166bb40927D94e969c51Af227bc22F30df6D2',
    POOL_FEE: 500,                                  // wsXMR/cbBTC V3 fee tier
    CBBTC_USDC_POOL: deployment.cbbtcUsdcPool,
    RPC_URL: process.env.BASE_RPC_URL || 'https://mainnet.base.org',
    EXPLORER: 'https://basescan.org',
};
