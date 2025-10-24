import { Connection, PublicKey, Keypair, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { BN } from '@coral-xyz/anchor';
import * as anchor from '@coral-xyz/anchor';
import { CONFIG } from './config.js';
import { IDL } from './idl.js';
import fs from 'fs';
import { randomBytes } from 'crypto';

export class SolanaClient {
  private connection: Connection;
  private provider: anchor.AnchorProvider;
  private program: anchor.Program;
  private wallet: Keypair;
  private programId = new PublicKey(CONFIG.SOLANA.PROGRAM_ID);
  private usdcMint = new PublicKey(CONFIG.SOLANA.USDC_MINT);

  constructor() {
    this.connection = new Connection(CONFIG.SOLANA.RPC_URL, 'confirmed');
    
    // Load wallet from file
    const keypairPath = CONFIG.SOLANA.KEYPAIR_PATH;
    const secretKey = Buffer.from(JSON.parse(fs.readFileSync(keypairPath, 'utf8')));
    this.wallet = Keypair.fromSecretKey(secretKey);
    
    this.provider = new anchor.AnchorProvider(
      this.connection,
      new anchor.Wallet(this.wallet),
      anchor.AnchorProvider.defaultOptions()
    );
    
    anchor.setProvider(this.provider);
    this.program = new anchor.Program(IDL as any, this.programId, this.provider);
  }

  async createUsdcToXmrSwap(
    aliceKeypair: Keypair,
    bob: PublicKey,
    usdcAmount: BN,
    xmrAmount: BN,
    moneroSubAddress: string,
    secretHash: Buffer,
    expiry: BN,
    relayerFee: BN
  ) {
    const swapId = randomBytes(32);
    
    const [swapPda] = PublicKey.findProgramAddressSync(
      [Buffer.from('swap'), swapId],
      this.programId
    );

    const aliceUsdc = getAssociatedTokenAddressSync(this.usdcMint, aliceKeypair.publicKey);
    const vaultUsdc = getAssociatedTokenAddressSync(this.usdcMint, swapPda, true);

    const tx = await this.program.methods
      .createUsdcToXmrSwap(
        Array.from(swapId),
        Array.from(secretHash),
        usdcAmount,
        xmrAmount,
        moneroSubAddress.padEnd(64, '\0').split('').map(c => c.charCodeAt(0)),
        expiry,
        relayerFee
      )
      .accounts({
        swap: swapPda,
        alice: aliceKeypair.publicKey,
        bob,
        aliceUsdc,
        vaultUsdc,
        usdcMint: this.usdcMint,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId
      })
      .transaction();

    const signature = await sendAndConfirmTransaction(
      this.connection,
      tx,
      [aliceKeypair]
    );

    return { signature, swapId: swapId.toString('hex') };
  }

  async redeemUsdc(signerKeypair: Keypair, swapId: string, adaptorSig: Buffer) {
    const swapIdBytes = Buffer.from(swapId, 'hex');
    
    const [swapPda] = PublicKey.findProgramAddressSync(
      [Buffer.from('swap'), swapIdBytes],
      this.programId
    );

    const swapAcct = await this.program.account.swap.fetch(swapPda);
    const vaultUsdc = getAssociatedTokenAddressSync(this.usdcMint, swapPda, true);
    const recipientToken = getAssociatedTokenAddressSync(this.usdcMint, swapAcct.bob as PublicKey);
    const relayerToken = getAssociatedTokenAddressSync(this.usdcMint, this.wallet.publicKey);

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
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId
      })
      .transaction();

    return await sendAndConfirmTransaction(
      this.connection,
      tx,
      [signerKeypair, this.wallet]
    );
  }

  async getSwap(swapId: string) {
    const swapIdBytes = Buffer.from(swapId, 'hex');
    const [swapPda] = PublicKey.findProgramAddressSync(
      [Buffer.from('swap'), swapIdBytes],
      this.programId
    );
    
    return await this.program.account.swap.fetch(swapPda);
  }

  async getBalance(pubkey: string): Promise<number> {
    const tokenAccount = getAssociatedTokenAddressSync(
      this.usdcMint,
      new PublicKey(pubkey)
    );
    
    try {
      const accountInfo = await this.connection.getTokenAccountBalance(tokenAccount);
      return accountInfo.value.uiAmount || 0;
    } catch {
      return 0;
    }
  }

  getWalletPublicKey(): PublicKey {
    return this.wallet.publicKey;
  }

  getWalletKeypair(): Keypair {
    return this.wallet;
  }

  async createXmrToUsdcSwap(
    bobKeypair: Keypair,
    alice: PublicKey,
    usdcAmount: BN,
    xmrAmount: BN,
    aliceSolana: PublicKey,
    secretHash: Buffer,
    expiry: BN,
    relayerFee: BN
  ) {
    const swapId = randomBytes(32);
    
    const [swapPda] = PublicKey.findProgramAddressSync(
      [Buffer.from('swap'), swapId],
      this.programId
    );

    const bobUsdc = getAssociatedTokenAddressSync(this.usdcMint, bobKeypair.publicKey);
    const vaultUsdc = getAssociatedTokenAddressSync(this.usdcMint, swapPda, true);

    const tx = await this.program.methods
      .createXmrToUsdcSwap(
        Array.from(swapId),
        Array.from(secretHash),
        usdcAmount,
        xmrAmount,
        aliceSolana,
        expiry,
        relayerFee
      )
      .accounts({
        swap: swapPda,
        alice,
        bob: bobKeypair.publicKey,
        bobUsdc,
        vaultUsdc,
        usdcMint: this.usdcMint,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: anchor.web3.SystemProgram.programId
      })
      .transaction();

    const signature = await sendAndConfirmTransaction(
      this.connection,
      tx,
      [bobKeypair]
    );

    return { signature, swapId: swapId.toString('hex') };
  }
}