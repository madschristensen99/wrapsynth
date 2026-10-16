const fs = require('fs');
const path = require('path');

// BNB Chain deployment manifest written by DeployBnb.s.sol
const deploymentPath = path.join(__dirname, '../deployments/bnb-deployment.json');
const deployment = JSON.parse(fs.readFileSync(deploymentPath, 'utf8'));

module.exports = {
    HUB_ADDRESS: deployment.wsXmrHub,
    WSXMR_ADDRESS: deployment.wsXMR,
    LIQUIDITY_ROUTER: deployment.liquidityRouter,
    POOL_ADDRESS: deployment.pool,
    STATA_ADDRESS: deployment.stataQQQB,          // collateral share token
    QQQB_ADDRESS: deployment.qqqb,                // underlying collateral token
    WBNB_ADDRESS: deployment.wbnb,
    USDT_ADDRESS: deployment.usdt,
    ED25519_HELPER: process.env.ED25519_HELPER || '0x85e8fc329B2C9A44e7D653f347dfA5269575f9A3',
    PCS_V3_FACTORY: deployment.pcsV3Factory,
    PCS_V3_POSITION_MANAGER: deployment.pcsV3NFPM,
    PCS_SMART_ROUTER: deployment.pcsSmartRouter,
    PCS_V3_QUOTER_V2: deployment.pcsV3QuoterV2,
    // Redeployed with pancakeV3SwapCallback (original lacked the PancakeSwap selector)
    SWAP_HELPER: process.env.SWAP_HELPER || '0x174963025EFc9E2d266eD96FD0e615dd24A1bADD',
    POOL_FEE: 500,                                // wsXMR/QQQB V3 fee tier
    QQQB_WBNB_POOL: deployment.qqqbWbnbPool,
    WBNB_USDT_POOL: deployment.wbnbUsdtPool,
    RPC_URL: process.env.BSC_RPC_URL || 'https://bsc-dataseed.bnbchain.org',
};
