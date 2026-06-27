#!/usr/bin/env node
// Manual script to call setMintReady for a specific mint request
// Usage: node manual-setMintReady.js <requestId>

import 'dotenv/config';
import * as ethers from 'ethers';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { WrapperBuilder } from '@redstone-finance/evm-connector';
import { getSignersForDataServiceId } from '@redstone-finance/oracles-smartweave-contracts';

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
  'function setMintReady(bytes32 requestId) external payable',
  'function updateOraclePrices(bytes[] calldata) external payable',
  'function getVault(address lpAddress) external view returns (tuple(address lpAddress, uint256 collateralShares, uint256 lockedCollateral, uint256 normalizedDebt, uint256 pendingDebt, uint16 maxMintBps, uint256 mintGriefingDeposit, uint256 mintReadyBond, uint16 mintFeeBps, uint16 burnRewardBps, uint256 liquidationNonce, uint256 mintNonce, uint256 minBurnAmount, bool active, uint256 deployedSDAIShares, uint16 maxCoLPRangeBps))',
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
  // Step 1: Update oracle prices with RedStone
  console.log('\n1. Updating oracle prices with RedStone...');
  
  console.log('   Getting authorized signers...');
  const authorizedSigners = getSignersForDataServiceId('redstone-primary-prod');
  console.log(`   Found ${authorizedSigners ? authorizedSigners.length : 0} signers`);
  
  console.log('   Wrapping contract...');
  const wrappedHub = WrapperBuilder.wrap(hub).usingDataService({
    dataServiceId: 'redstone-primary-prod',
    uniqueSignersCount: 3,
    dataPackagesIds: ['XMR', 'DAI'],
    authorizedSigners
  });
  
  console.log('   Calling updateOraclePrices...');
  const updateTx = await wrappedHub.updateOraclePrices([]);
  console.log(`   Oracle update tx: ${updateTx.hash}`);
  await updateTx.wait();
  console.log('   ✅ Oracle prices updated');

  // Step 2: Get required bond
  console.log('\n2. Fetching vault configuration...');
  const vault = await hub.getVault(wallet.address);
  const requiredBond = vault.mintReadyBond;
  console.log(`   Required bond: ${ethers.formatEther(requiredBond)} xDAI`);

  // Step 3: Call setMintReady
  console.log('\n3. Calling setMintReady...');
  const tx = await hub.setMintReady(requestId, { value: requiredBond });
  console.log(`   Transaction hash: ${tx.hash}`);
  
  console.log('   Waiting for confirmation...');
  const receipt = await tx.wait();
  console.log(`   ✅ Confirmed in block ${receipt.blockNumber}`);
  console.log(`   Gas used: ${receipt.gasUsed.toString()}`);
  
  console.log('\n✅ Mint is now ready! User can finalize by revealing their secret.');
  
} catch (err) {
  console.error('\n❌ Error:', err.message);
  if (err.data) {
    console.error('Error data:', err.data);
  }
  if (err.code === 'CALL_EXCEPTION' && err.data === '0x19abf40e') {
    console.error('\nThis is a StalePrice error. The oracle update may have failed.');
  }
  process.exit(1);
}
