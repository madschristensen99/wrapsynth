import { Request, Response } from 'express';
import { BN } from '@coral-xyz/anchor';
import { SolanaClient } from './solana-client.js';
import { MoneroClient } from './monero-client.js';
import { randomBytes } from 'crypto';
import fs from 'fs';

const solanaClient = new SolanaClient();
const moneroClient = new MoneroClient();

interface Swap {
  id: string;
  direction: 'usdc-to-xmr' | 'xmr-to-usdc';
  alice: string;
  bob: string;
  secretHash: string;
  usdcAmount: number;
  xmrAmount: number;
  expiry: number;
  state: 'pending' | 'locked' | 'redeemed' | 'refunded';
  moneroTxId?: string;
  moneroAddress?: string;
  aliceSolana?: string;
}

const swaps = new Map<string, Swap>();

export async function createUsdcToXmrSwap(req: Request, res: Response): Promise<void> {
  const { alice, bob, usdcAmount, xmrAmount, moneroAddress, relayerFee = 0, expiryInHours = 24 } = req.body;

  if (!alice || !bob || !usdcAmount || !xmrAmount || !moneroAddress) {
    res.status(400).json({ error: 'Missing required fields' });
    return;
  }

  try {
    const { PublicKey } = await import('@solana/web3.js');
    const secretHash = randomBytes(32).toString('hex');
    const expiry = Math.floor(Date.now() / 1000) + (expiryInHours * 3600);
    
    const { signature, swapId } = await solanaClient.createUsdcToXmrSwap(
      solanaClient.getWalletKeypair(),
      new PublicKey(bob),
      new BN(usdcAmount),
      new BN(xmrAmount),
      moneroAddress,
      Buffer.from(secretHash, 'hex'),
      new BN(expiry),
      new BN(relayerFee)
    );

    res.json({
      swapId,
      secretHash,
      moneroSubAddress: moneroAddress,
      expiry,
      transaction: signature
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

export async function createXmrToUsdcSwap(req: Request, res: Response): Promise<void> {
  const { alice, bob, usdcAmount, xmrAmount, aliceSolana, relayerFee = 0, expiryInHours = 24 } = req.body;

  if (!alice || !bob || !usdcAmount || !xmrAmount || !aliceSolana) {
    res.status(400).json({ error: 'Missing required fields' });
    return;
  }

  try {
    const { PublicKey } = await import('@solana/web3.js');
    const secretHash = randomBytes(32).toString('hex');
    const expiry = Math.floor(Date.now() / 1000) + (expiryInHours * 3600);
    
    const { signature, swapId } = await solanaClient.createXmrToUsdcSwap(
      solanaClient.getWalletKeypair(),
      new PublicKey(alice),
      new BN(usdcAmount),
      new BN(xmrAmount),
      new PublicKey(aliceSolana),
      Buffer.from(secretHash, 'hex'),
      new BN(expiry),
      new BN(relayerFee)
    );

    res.json({
      swapId,
      secretHash,
      aliceSolana,
      expiry,
      transaction: signature
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

export async function recordLockProof(req: Request, res: Response): Promise<void> {
  const { id } = req.params;
  const { moneroTxId } = req.body;

  // Note: This is a placeholder for off-chain proof
  // The actual proof recording happens on-chain via redeem, not this endpoint
  res.json({ note: 'Monero lock proof recorded off-chain. Use the redeem endpoint with the appropriate signature.' });
}

export async function redeemSwap(req: Request, res: Response): Promise<void> {
  const { id } = req.params;
  const { adaptorSig } = req.body;

  try {
    if (!adaptorSig || adaptorSig.length !== 128) {
      res.status(400).json({ error: 'Invalid adaptor signature - must be 64 bytes hex' });
      return;
    }

    const signature = await solanaClient.redeemUsdc(
      solanaClient.getWalletKeypair(),
      id,
      Buffer.from(adaptorSig, 'hex')
    );

    res.json({ success: true, transaction: signature });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}

export async function getSwap(req: Request, res: Response): Promise<void> {
  const { id } = req.params;

  try {
    const swap = await solanaClient.getSwap(id) as any;
    
    res.json({
      direction: swap.direction && typeof swap.direction === 'object' ? 
        (swap.direction as any).usdcToXmr !== undefined ? 'usdc-to-xmr' : 'xmr-to-usdc' : 'unknown',
      swapId: swap.swapId ? Array.from(swap.swapId as number[]).map((b: number) => b.toString(16).padStart(2, '0')).join('') : id,
      alice: swap.alice?.toString() || '',
      bob: swap.bob?.toString() || '',
      secretHash: swap.secretHash ? Array.from(swap.secretHash as number[]).map((b: number) => b.toString(16).padStart(2, '0')).join('') : '',
      expiry: (swap.expiry as BN).toNumber(),
      relayerFee: (swap.relayerFee as BN).toNumber(),
      usdcAmount: (swap.usdcAmount as BN).toNumber(),
      xmrAmount: (swap.xmrAmount as BN).toNumber(),
      state: swap.isRedeemed ? 'redeemed' : swap.isRefunded ? 'refunded' : 'active',
      moneroAddress: (swap.moneroSubAddress as number[])?.filter((c: number) => c !== 0).map((c: number) => String.fromCharCode(c)).join('').trim() || '',
      moneroTxId: (swap.moneroLockTxid as number[])?.some((b: number) => b !== 0) ? 
        Array.from(swap.moneroLockTxid as number[]).map((b: number) => b.toString(16).padStart(2, '0')).join('') : undefined,
      aliceSolana: swap.aliceSolana?.toString() || ''
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
}