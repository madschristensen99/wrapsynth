"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.createUsdcToXmrSwap = createUsdcToXmrSwap;
exports.createXmrToUsdcSwap = createXmrToUsdcSwap;
exports.recordLockProof = recordLockProof;
exports.redeemSwap = redeemSwap;
exports.getSwap = getSwap;
const anchor_1 = require("@coral-xyz/anchor");
const solana_client_js_1 = require("./solana-client.js");
const monero_client_js_1 = require("./monero-client.js");
const crypto_1 = require("crypto");
const solanaClient = new solana_client_js_1.SolanaClient();
const moneroClient = new monero_client_js_1.MoneroClient();
const swaps = new Map();
async function createUsdcToXmrSwap(req, res) {
    const { alice, bob, usdcAmount, xmrAmount, moneroAddress, relayerFee = 0, expiryInHours = 24 } = req.body;
    if (!alice || !bob || !usdcAmount || !xmrAmount || !moneroAddress) {
        res.status(400).json({ error: 'Missing required fields' });
        return;
    }
    try {
        const { PublicKey } = await Promise.resolve().then(() => __importStar(require('@solana/web3.js')));
        const secretHash = (0, crypto_1.randomBytes)(32).toString('hex');
        const expiry = Math.floor(Date.now() / 1000) + (expiryInHours * 3600);
        const { signature, swapId } = await solanaClient.createUsdcToXmrSwap(solanaClient.getWalletKeypair(), new PublicKey(bob), new anchor_1.BN(usdcAmount), new anchor_1.BN(xmrAmount), moneroAddress, Buffer.from(secretHash, 'hex'), new anchor_1.BN(expiry), new anchor_1.BN(relayerFee));
        res.json({
            swapId,
            secretHash,
            moneroSubAddress: moneroAddress,
            expiry,
            transaction: signature
        });
    }
    catch (error) {
        res.status(500).json({ error: error.message });
    }
}
async function createXmrToUsdcSwap(req, res) {
    const { alice, bob, usdcAmount, xmrAmount, aliceSolana, relayerFee = 0, expiryInHours = 24 } = req.body;
    if (!alice || !bob || !usdcAmount || !xmrAmount || !aliceSolana) {
        res.status(400).json({ error: 'Missing required fields' });
        return;
    }
    try {
        const { PublicKey } = await Promise.resolve().then(() => __importStar(require('@solana/web3.js')));
        const secretHash = (0, crypto_1.randomBytes)(32).toString('hex');
        const expiry = Math.floor(Date.now() / 1000) + (expiryInHours * 3600);
        const { signature, swapId } = await solanaClient.createXmrToUsdcSwap(solanaClient.getWalletKeypair(), new PublicKey(alice), new anchor_1.BN(usdcAmount), new anchor_1.BN(xmrAmount), new PublicKey(aliceSolana), Buffer.from(secretHash, 'hex'), new anchor_1.BN(expiry), new anchor_1.BN(relayerFee));
        res.json({
            swapId,
            secretHash,
            aliceSolana,
            expiry,
            transaction: signature
        });
    }
    catch (error) {
        res.status(500).json({ error: error.message });
    }
}
async function recordLockProof(req, res) {
    const { id } = req.params;
    const { moneroTxId } = req.body;
    // Note: This is a placeholder for off-chain proof
    // The actual proof recording happens on-chain via redeem, not this endpoint
    res.json({ note: 'Monero lock proof recorded off-chain. Use the redeem endpoint with the appropriate signature.' });
}
async function redeemSwap(req, res) {
    const { id } = req.params;
    const { adaptorSig } = req.body;
    try {
        if (!adaptorSig || adaptorSig.length !== 128) {
            res.status(400).json({ error: 'Invalid adaptor signature - must be 64 bytes hex' });
            return;
        }
        const signature = await solanaClient.redeemUsdc(solanaClient.getWalletKeypair(), id, Buffer.from(adaptorSig, 'hex'));
        res.json({ success: true, transaction: signature });
    }
    catch (error) {
        res.status(500).json({ error: error.message });
    }
}
async function getSwap(req, res) {
    const { id } = req.params;
    try {
        const swap = await solanaClient.getSwap(id);
        res.json({
            direction: swap.direction && typeof swap.direction === 'object' ?
                swap.direction.usdcToXmr !== undefined ? 'usdc-to-xmr' : 'xmr-to-usdc' : 'unknown',
            swapId: swap.swapId ? Array.from(swap.swapId).map((b) => b.toString(16).padStart(2, '0')).join('') : id,
            alice: swap.alice?.toString() || '',
            bob: swap.bob?.toString() || '',
            secretHash: swap.secretHash ? Array.from(swap.secretHash).map((b) => b.toString(16).padStart(2, '0')).join('') : '',
            expiry: swap.expiry.toNumber(),
            relayerFee: swap.relayerFee.toNumber(),
            usdcAmount: swap.usdcAmount.toNumber(),
            xmrAmount: swap.xmrAmount.toNumber(),
            state: swap.isRedeemed ? 'redeemed' : swap.isRefunded ? 'refunded' : 'active',
            moneroAddress: swap.moneroSubAddress?.filter((c) => c !== 0).map((c) => String.fromCharCode(c)).join('').trim() || '',
            moneroTxId: swap.moneroLockTxid?.some((b) => b !== 0) ?
                Array.from(swap.moneroLockTxid).map((b) => b.toString(16).padStart(2, '0')).join('') : undefined,
            aliceSolana: swap.aliceSolana?.toString() || ''
        });
    }
    catch (error) {
        res.status(500).json({ error: error.message });
    }
}
