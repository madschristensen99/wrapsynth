#!/usr/bin/env node
// Check if LP keys are posted for a mint
// Usage: node check-mint-keys.js <requestId>

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
  'function lpPublicKeys(bytes32 requestId) external view returns (bytes32)',
  'function lpPublicViewKeys(bytes32 requestId) external view returns (bytes32)',
];

const requestId = process.argv[2] || '0xf12d51ce422a3d140d6492e541563f8f0f2da3d6cfe8ca6d02366e1a6bd4a745';

const provider = new ethers.JsonRpcProvider(RPC_URL, CHAIN_ID);
const hub = new ethers.Contract(HUB_ADDRESS, HUB_ABI, provider);

console.log(`Checking LP keys for: ${requestId}\n`);

try {
  const spendKey = await hub.lpPublicKeys(requestId);
  const viewKey = await hub.lpPublicViewKeys(requestId);
  
  console.log('LP Public Spend Key:', spendKey);
  console.log('LP Public View Key:', viewKey);
  
  const hasKeys = spendKey !== '0x0000000000000000000000000000000000000000000000000000000000000000';
  
  if (hasKeys) {
    console.log('\n✅ LP has posted keys on-chain');
    console.log('\nThe frontend should be able to derive the Monero deposit address from these keys.');
  } else {
    console.log('\n❌ LP has NOT posted keys yet');
  }
  
} catch (err) {
  console.error('Error:', err.message);
  process.exit(1);
}
