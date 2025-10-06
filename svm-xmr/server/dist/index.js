"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const cors_1 = __importDefault(require("cors"));
const handlers_js_1 = require("./handlers.js");
const config_js_1 = require("./config.js");
const app = (0, express_1.default)();
const port = config_js_1.CONFIG.SERVER.PORT;
app.use((0, cors_1.default)());
app.use(express_1.default.json());
// Routes
app.post('/api/swap/create-usdc-to-xmr', handlers_js_1.createUsdcToXmrSwap);
app.post('/api/swap/create-xmr-to-usdc', handlers_js_1.createXmrToUsdcSwap);
app.post('/api/swap/:id/lock-proof', handlers_js_1.recordLockProof);
app.post('/api/swap/:id/redeem', handlers_js_1.redeemSwap);
app.get('/api/swap/:id', handlers_js_1.getSwap);
// Health check
app.get('/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});
app.listen(port, () => {
    console.log(`SVM-XMR server v1 running on port ${port}`);
    console.log(`Monero wallet RPC: ${config_js_1.CONFIG.MONERO.WALLET_RPC_URL}`);
    console.log(`Solana RPC: ${config_js_1.CONFIG.SOLANA.RPC_URL}`);
});
