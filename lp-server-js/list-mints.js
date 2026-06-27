#!/usr/bin/env node
// List all mints for a specific address
// Usage: node list-mints.js <userAddress>

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
  'event MintInitiated(bytes32 indexed requestId, address indexed initiator, address indexed recipient, address lpVault, uint256 xmrAmount, uint256 wsxmrAmount, uint256 feeAmount, bytes32 claimCommitment, bytes32 userPublicKey, uint256 timeout)',
  'function getMintRequest(bytes32 requestId) external view returns (tuple(address initiator, address recipient, address lpVault, uint256 xmrAmount, uint256 wsxmrAmount, uint256 feeAmount, bytes32 claimCommitment, bytes32 userPublicKey, uint256 timeout, uint256 state))',
];

const userAddress = process.argv[2];

if (!userAddress) {
  console.error('Usage: node list-mints.js <userAddress>');
  console.error('Example: node list-mints.js 0xDFdC570ec0586D5c00735a2277c21Dcc254B3917');
  process.exit(1);
}

const provider = new ethers.JsonRpcProvider(RPC_URL, CHAIN_ID);
const hub = new ethers.Contract(HUB_ADDRESS, HUB_ABI, provider);

console.log(`Searching for mints initiated by: ${userAddress}`);
console.log(`Hub: ${HUB_ADDRESS}\n`);

try {
  // Get deployment block from deployment.json or use a safe default
  const fromBlock = 46700000; // Search further back for old mints
  const currentBlock = await provider.getBlockNumber();
  
  console.log(`Scanning from block ${fromBlock} to ${currentBlock}...\n`);
  
  // Query MintInitiated events
  const filter = hub.filters.MintInitiated(null, userAddress);
  const events = await hub.queryFilter(filter, fromBlock, currentBlock);
  
  if (events.length === 0) {
    console.log('No mints found for this address.');
    process.exit(0);
  }
  
  console.log(`Found ${events.length} mint(s):\n`);
  
  for (const event of events) {
    const requestId = event.args.requestId;
    const timeout = event.args.timeout;
    
    // Get current state
    let mintReq, state, stateName;
    try {
      mintReq = await hub.getMintRequest(requestId);
      state = Number(mintReq.state);
      const stateNames = ['INVALID', 'PENDING', 'KEY_PROVIDED', 'READY', 'COMPLETED', 'CANCELLED'];
      stateName = stateNames[state] || `UNKNOWN(${state})`;
    } catch (err) {
      state = -1;
      stateName = 'ERROR';
    }
    
    const canCancel = currentBlock >= timeout && state !== 4 && state !== 5;
    
    console.log(`Request ID: ${requestId}`);
    console.log(`  State: ${stateName} (${state})`);
    console.log(`  XMR Amount: ${ethers.formatUnits(event.args.xmrAmount, 12)} XMR`);
    console.log(`  Timeout Block: ${timeout.toString()}`);
    console.log(`  Current Block: ${currentBlock}`);
    console.log(`  Can Cancel: ${canCancel ? '✅ YES' : '❌ NO'}`);
    console.log(`  Block: ${event.blockNumber}`);
    console.log(`  Tx: ${event.transactionHash}`);
    console.log('');
  }
  
} catch (err) {
  console.error('Error:', err.message);
  process.exit(1);
}
