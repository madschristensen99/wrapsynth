#!/usr/bin/env node
// Manual script to call setMintReady for a specific mint request
// Usage: node manual-setMintReady.js <requestId>
//
// Oracle-free: no price push and no payable bond — setMintReady locks the
// par-value key bond (wsxmr × threshold / 1e8 × 110%) against the vault's
// declared threshold inside the hub's own accounting.

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
  'function setMintReady(bytes32 requestId) external',
  'function getVault(address lpAddress) external view returns (tuple(address lpAddress, uint256 collateralShares, uint256 lockedCollateral, uint256 normalizedDebt, uint256 pendingDebt, uint256 thresholdSharesPerWsxmr, uint256 maxMintWsxmr, uint256 mintGriefingDeposit, uint16 mintFeeBps, uint16 burnRewardBps, uint256 liquidationNonce, uint256 mintNonce, uint256 minBurnAmount, bool active, uint256 deployedCollateral, uint256 deployedWsxmr, uint16 maxCoLPRangeBps, uint256 mintTimeoutBlocks, uint256 burnTimeoutBlocks, uint256 pendingMintCount))',
];

const provider = new ethers.JsonRpcProvider(RPC_URL, CHAIN_ID);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
const hub = new ethers.Contract(HUB_ADDRESS, HUB_ABI, wallet);

const requestId = process.argv[2];

if (!requestId) {
  console.error('Usage: node manual-setMintReady.js <requestId>');
  console.error('Example: node manual-setMintReady.js 0x72a1194196950ac7dbbd4cbbefd1d726e48cfd629ca3b26d71c95a47c943cac4');
  process.exit(1);
}

console.log(`Calling setMintReady for request: ${requestId}`);
console.log(`LP Wallet: ${wallet.address}`);
console.log(`Hub: ${HUB_ADDRESS}`);

try {
  const vault = await hub.getVault(wallet.address);
  console.log(`Vault threshold: ${ethers.formatEther(vault.thresholdSharesPerWsxmr)} normalized collateral / 1e8 wsXMR`);
  console.log(`Locked collateral: ${ethers.formatEther(vault.lockedCollateral)}`);

  console.log('\nCalling setMintReady...');
  const tx = await hub.setMintReady(requestId);
  console.log(`   Transaction hash: ${tx.hash}`);

  const receipt = await tx.wait();
  console.log(`   Confirmed in block ${receipt.blockNumber}`);
  console.log(`   Gas used: ${receipt.gasUsed.toString()}`);

  console.log('\nMint is now ready! User can finalize by revealing their secret.');

} catch (err) {
  console.error('\nError:', err.message);
  if (err.data) {
    console.error('Error data:', err.data);
  }
  process.exit(1);
}
