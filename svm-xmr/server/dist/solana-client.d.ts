import { PublicKey, Keypair } from '@solana/web3.js';
import { BN } from '@coral-xyz/anchor';
export declare class SolanaClient {
    private connection;
    private provider;
    private program;
    private wallet;
    private programId;
    private usdcMint;
    constructor();
    createUsdcToXmrSwap(aliceKeypair: Keypair, bob: PublicKey, usdcAmount: BN, xmrAmount: BN, moneroSubAddress: string, secretHash: Buffer, expiry: BN, relayerFee: BN): Promise<{
        signature: string;
        swapId: string;
    }>;
    redeemUsdc(signerKeypair: Keypair, swapId: string, adaptorSig: Buffer): Promise<string>;
    getSwap(swapId: string): Promise<{
        [x: string]: unknown;
    }>;
    getBalance(pubkey: string): Promise<number>;
    getWalletPublicKey(): PublicKey;
    getWalletKeypair(): Keypair;
    createXmrToUsdcSwap(bobKeypair: Keypair, alice: PublicKey, usdcAmount: BN, xmrAmount: BN, aliceSolana: PublicKey, secretHash: Buffer, expiry: BN, relayerFee: BN): Promise<{
        signature: string;
        swapId: string;
    }>;
}
