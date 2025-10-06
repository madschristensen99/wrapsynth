import express from 'express';
import cors from 'cors';
import { 
  createUsdcToXmrSwap, 
  createXmrToUsdcSwap, 
  recordLockProof, 
  redeemSwap, 
  getSwap 
} from './handlers.js';
import { CONFIG } from './config.js';

const app = express();
const port = CONFIG.SERVER.PORT;

app.use(cors());
app.use(express.json());

// Routes
app.post('/api/swap/create-usdc-to-xmr', createUsdcToXmrSwap);
app.post('/api/swap/create-xmr-to-usdc', createXmrToUsdcSwap);
app.post('/api/swap/:id/lock-proof', recordLockProof);
app.post('/api/swap/:id/redeem', redeemSwap);
app.get('/api/swap/:id', getSwap);

// Health check
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.listen(port, () => {
  console.log(`SVM-XMR server v1 running on port ${port}`);
  console.log(`Monero wallet RPC: ${CONFIG.MONERO.WALLET_RPC_URL}`);
  console.log(`Solana RPC: ${CONFIG.SOLANA.RPC_URL}`);
});