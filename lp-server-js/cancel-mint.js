#!/usr/bin/env node
// Cancel a mint and get griefing deposit refund
// Usage: node cancel-mint.js <requestId> <userPrivateKey>

import 'dotenv/config';
import * as ethers from 'ethers';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const RPC_URL = process.env.RPC_URL || 'https://rpc.gnosischain.com';

const deploymentPath = path.join(__dirname, '..', 'deployment.json');
const deployment = JSON.parse(fs.readFileSync(deploymentPath, 'utf8'));
const HUB_ADDRESS = deployment.contracts.wsXmrHub;
const CHAIN_ID = deployment.chainId || 100;

const HUB_ABI = [
  'function cancelMint(bytes32 requestId) external',
  'function getMintRequest(bytes32 requestId) external view returns (tuple(address initiator, address recipient, address lpVault, uint256 xmrAmount, uint256 wsxmrAmount, uint256 feeAmount, bytes32 claimCommitment, bytes32 userPublicKey, uint256 timeout, uint256 state))',
];

const requestId = process.argv[2];
const userPrivateKey = process.argv[3];

if (!requestId || !userPrivateKey) {
  console.error('Usage: node cancel-mint.js <requestId> <userPrivateKey>');
  console.error('Example: node cancel-mint.js 0x72a1... 0xabcd...');
  console.error('\nThis will cancel the mint and refund your griefing deposit (if timeout has passed).');
  process.exit(1);
}

const provider = new ethers.JsonRpcProvider(RPC_URL, CHAIN_ID);
const wallet = new ethers.Wallet(userPrivateKey, provider);
const hub = new ethers.Contract(HUB_ADDRESS, HUB_ABI, wallet);

console.log(`Cancelling mint for request: ${requestId}`);
console.log(`User Wallet: ${wallet.address}`);
console.log(`Hub: ${HUB_ADDRESS}`);

try {
  // Skip state check due to ABI issues - just try to cancel
  console.log('\n1. Attempting to cancel mint...');
  console.log('   (Contract will revert if not cancellable)');
  const tx = await hub.cancelMint(requestId);
  console.log(`   Transaction hash: ${tx.hash}`);
  
  console.log('   Waiting for confirmation...');
  const receipt = await tx.wait();
  console.log(`   ✅ Confirmed in block ${receipt.blockNumber}`);
  console.log(`   Gas used: ${receipt.gasUsed.toString()}`);
  
  console.log('\n✅ Mint cancelled! Your griefing deposit should be refunded.');
  console.log('   Check Pending Returns in the frontend to claim it.');
  
} catch (err) {
  console.error('\n❌ Error:', err.message);
  if (err.reason) {
    console.error('Revert reason:', err.reason);
  }
  if (err.code === 'CALL_EXCEPTION') {
    if (err.message.includes('TimeoutNotReached')) {
      console.error('\n⚠️  The timeout has not been reached yet. You must wait until the timeout block.');
    } else if (err.message.includes('InvalidStatus')) {
      console.error('\n⚠️  Mint is in a state that cannot be cancelled (might be READY or COMPLETED).');
    }
  }
  process.exit(1);
}
