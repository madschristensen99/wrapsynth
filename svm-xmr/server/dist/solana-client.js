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
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SolanaClient = void 0;
const web3_js_1 = require("@solana/web3.js");
const spl_token_1 = require("@solana/spl-token");
const anchor = __importStar(require("@coral-xyz/anchor"));
const config_js_1 = require("./config.js");
const idl_js_1 = require("./idl.js");
const fs_1 = __importDefault(require("fs"));
const crypto_1 = require("crypto");
class SolanaClient {
    constructor() {
        this.programId = new web3_js_1.PublicKey(config_js_1.CONFIG.SOLANA.PROGRAM_ID);
        this.usdcMint = new web3_js_1.PublicKey(config_js_1.CONFIG.SOLANA.USDC_MINT);
        this.connection = new web3_js_1.Connection(config_js_1.CONFIG.SOLANA.RPC_URL, 'confirmed');
        // Load wallet from file
        const keypairPath = config_js_1.CONFIG.SOLANA.KEYPAIR_PATH;
        const secretKey = Buffer.from(JSON.parse(fs_1.default.readFileSync(keypairPath, 'utf8')));
        this.wallet = web3_js_1.Keypair.fromSecretKey(secretKey);
        this.provider = new anchor.AnchorProvider(this.connection, new anchor.Wallet(this.wallet), anchor.AnchorProvider.defaultOptions());
        anchor.setProvider(this.provider);
        this.program = new anchor.Program(idl_js_1.IDL, this.programId, this.provider);
    }
    async createUsdcToXmrSwap(aliceKeypair, bob, usdcAmount, xmrAmount, moneroSubAddress, secretHash, expiry, relayerFee) {
        const swapId = (0, crypto_1.randomBytes)(32);
        const [swapPda] = web3_js_1.PublicKey.findProgramAddressSync([Buffer.from('swap'), swapId], this.programId);
        const aliceUsdc = (0, spl_token_1.getAssociatedTokenAddressSync)(this.usdcMint, aliceKeypair.publicKey);
        const vaultUsdc = (0, spl_token_1.getAssociatedTokenAddressSync)(this.usdcMint, swapPda, true);
        const tx = await this.program.methods
            .createUsdcToXmrSwap(Array.from(swapId), Array.from(secretHash), usdcAmount, xmrAmount, moneroSubAddress.padEnd(64, '\0').split('').map(c => c.charCodeAt(0)), expiry, relayerFee)
            .accounts({
            swap: swapPda,
            alice: aliceKeypair.publicKey,
            bob,
            aliceUsdc,
            vaultUsdc,
            usdcMint: this.usdcMint,
            tokenProgram: spl_token_1.TOKEN_PROGRAM_ID,
            associatedTokenProgram: spl_token_1.ASSOCIATED_TOKEN_PROGRAM_ID,
            systemProgram: anchor.web3.SystemProgram.programId
        })
            .transaction();
        const signature = await (0, web3_js_1.sendAndConfirmTransaction)(this.connection, tx, [aliceKeypair]);
        return { signature, swapId: swapId.toString('hex') };
    }
    async redeemUsdc(signerKeypair, swapId, adaptorSig) {
        const swapIdBytes = Buffer.from(swapId, 'hex');
        const [swapPda] = web3_js_1.PublicKey.findProgramAddressSync([Buffer.from('swap'), swapIdBytes], this.programId);
        const swapAcct = await this.program.account.swap.fetch(swapPda);
        const vaultUsdc = (0, spl_token_1.getAssociatedTokenAddressSync)(this.usdcMint, swapPda, true);
        const recipientToken = (0, spl_token_1.getAssociatedTokenAddressSync)(this.usdcMint, swapAcct.bob);
        const relayerToken = (0, spl_token_1.getAssociatedTokenAddressSync)(this.usdcMint, this.wallet.publicKey);
        const tx = await this.program.methods
            .redeemUsdc(Array.from(swapIdBytes), Array.from(adaptorSig))
            .accounts({
            swap: swapPda,
            bob: signerKeypair.publicKey,
            vaultUsdc,
            bobToken: recipientToken,
            relayerToken,
            relayer: this.wallet.publicKey,
            usdcMint: this.usdcMint,
            tokenProgram: spl_token_1.TOKEN_PROGRAM_ID,
            associatedTokenProgram: spl_token_1.ASSOCIATED_TOKEN_PROGRAM_ID,
            systemProgram: anchor.web3.SystemProgram.programId
        })
            .transaction();
        return await (0, web3_js_1.sendAndConfirmTransaction)(this.connection, tx, [signerKeypair, this.wallet]);
    }
    async getSwap(swapId) {
        const swapIdBytes = Buffer.from(swapId, 'hex');
        const [swapPda] = web3_js_1.PublicKey.findProgramAddressSync([Buffer.from('swap'), swapIdBytes], this.programId);
        return await this.program.account.swap.fetch(swapPda);
    }
    async getBalance(pubkey) {
        const tokenAccount = (0, spl_token_1.getAssociatedTokenAddressSync)(this.usdcMint, new web3_js_1.PublicKey(pubkey));
        try {
            const accountInfo = await this.connection.getTokenAccountBalance(tokenAccount);
            return accountInfo.value.uiAmount || 0;
        }
        catch {
            return 0;
        }
    }
    getWalletPublicKey() {
        return this.wallet.publicKey;
    }
    getWalletKeypair() {
        return this.wallet;
    }
    async createXmrToUsdcSwap(bobKeypair, alice, usdcAmount, xmrAmount, aliceSolana, secretHash, expiry, relayerFee) {
        const swapId = (0, crypto_1.randomBytes)(32);
        const [swapPda] = web3_js_1.PublicKey.findProgramAddressSync([Buffer.from('swap'), swapId], this.programId);
        const bobUsdc = (0, spl_token_1.getAssociatedTokenAddressSync)(this.usdcMint, bobKeypair.publicKey);
        const vaultUsdc = (0, spl_token_1.getAssociatedTokenAddressSync)(this.usdcMint, swapPda, true);
        const tx = await this.program.methods
            .createXmrToUsdcSwap(Array.from(swapId), Array.from(secretHash), usdcAmount, xmrAmount, aliceSolana, expiry, relayerFee)
            .accounts({
            swap: swapPda,
            alice,
            bob: bobKeypair.publicKey,
            bobUsdc,
            vaultUsdc,
            usdcMint: this.usdcMint,
            tokenProgram: spl_token_1.TOKEN_PROGRAM_ID,
            associatedTokenProgram: spl_token_1.ASSOCIATED_TOKEN_PROGRAM_ID,
            systemProgram: anchor.web3.SystemProgram.programId
        })
            .transaction();
        const signature = await (0, web3_js_1.sendAndConfirmTransaction)(this.connection, tx, [bobKeypair]);
        return { signature, swapId: swapId.toString('hex') };
    }
}
exports.SolanaClient = SolanaClient;
