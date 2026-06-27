#!/usr/bin/env node
// Manual script to finalize a mint if you know the secret
// Usage: node finalize-mint-manual.js <requestId> <secret>

import 'dotenv/config';
import * as ethers from 'ethers';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const RPC_URL = process.env.RPC_URL || 'https://rpc.gnosischain.com';
const PRIVATE_KEY = process.env.PRIVATE_KEY;

if (!PRIVATE_KEY) {
  console.error('Error: PRIVATE_KEY env var is required');
  process.exit(1);
}

const deploymentPath = path.join(__dirname, '..', 'deployment.json');
const deployment = JSON.parse(fs.readFileSync(deploymentPath, 'utf8'));
const HUB_ADDRESS = deployment.contracts.wsXmrHub;
const CHAIN_ID = deployment.chainId || 100;

const HUB_ABI = [
  'function finalizeMint(bytes32 requestId, bytes32 secret) external',
  'function getMintRequest(bytes32 requestId) external view returns (tuple(address initiator, address recipient, address lpVault, uint256 xmrAmount, uint256 wsxmrAmount, uint256 feeAmount, bytes32 claimCommitment, bytes32 userPublicKey, uint256 timeout, uint256 state))',
];

const provider = new ethers.JsonRpcProvider(RPC_URL, CHAIN_ID);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
const hub = new ethers.Contract(HUB_ADDRESS, HUB_ABI, wallet);

const requestId = process.argv[2];
const secret = process.argv[3];

if (!requestId || !secret) {
  console.error('Usage: node finalize-mint-manual.js <requestId> <secret>');
  console.error('Example: node finalize-mint-manual.js 0x72a1... 0xabcd...');
  console.error('\nIf you don\'t have your secret, check browser localStorage or console logs from when you initiated the mint.');
  process.exit(1);
}

console.log(`Finalizing mint for request: ${requestId}`);
console.log(`User Wallet: ${wallet.address}`);
console.log(`Hub: ${HUB_ADDRESS}`);
console.log(`Secret: ${secret}`);

try {
  // Check mint status
  console.log('\n1. Checking mint status...');
  const mintReq = await hub.getMintRequest(requestId);
  console.log(`   State: ${mintReq.state} (2 = READY)`);
  console.log(`   Recipient: ${mintReq.recipient}`);
  console.log(`   wsXMR Amount: ${ethers.formatUnits(mintReq.wsxmrAmount, 8)} wsXMR`);

  if (mintReq.state.toString() !== '2') {
    console.error(`\n❌ Mint is not in READY state (current state: ${mintReq.state})`);
    process.exit(1);
  }

  // Finalize mint
  console.log('\n2. Calling finalizeMint...');
  const tx = await hub.finalizeMint(requestId, secret);
  console.log(`   Transaction hash: ${tx.hash}`);
  
  console.log('   Waiting for confirmation...');
  const receipt = await tx.wait();
  console.log(`   ✅ Confirmed in block ${receipt.blockNumber}`);
  console.log(`   Gas used: ${receipt.gasUsed.toString()}`);
  
  console.log('\n✅ Mint finalized! You should now have your wsXMR tokens.');
  
} catch (err) {
  console.error('\n❌ Error:', err.message);
  if (err.reason) {
    console.error('Revert reason:', err.reason);
  }
  if (err.code === 'CALL_EXCEPTION') {
    console.error('\nPossible causes:');
    console.error('- Wrong secret (doesn\'t match the commitment)');
    console.error('- Mint already finalized');
    console.error('- Mint expired or cancelled');
  }
  process.exit(1);
}
