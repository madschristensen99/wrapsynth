// Script to manually process a past burn request that the server missed
import * as ethers from 'ethers';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { computeSecretHash } from './commitment.js';

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
  'event BurnRequested(bytes32 indexed requestId, address indexed user, address indexed lpVault, uint256 wsxmrAmount, uint256 xmrAmount, uint256 rewardCollateral, bytes32 claimCommitment)',
  'function proposeHash(bytes32 requestId, bytes32 secretHash, bytes32 lpPublicSpendKey, bytes32 lpPublicViewKey) external',
  'function getBurnRequest(bytes32 requestId) external view returns (tuple(address user, address lpVault, uint256 wsxmrAmount, uint256 xmrAmount, uint256 feeAmount, uint256 collateralLocked, uint256 rewardCollateral, bytes32 claimCommitment, bytes32 secretHash, uint256 timeout, uint256 commitDeadline, uint256 state))',
];

const provider = new ethers.JsonRpcProvider(RPC_URL, CHAIN_ID);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
const hub = new ethers.Contract(HUB_ADDRESS, HUB_ABI, wallet);

const requestId = process.argv[2];
if (!requestId) {
  console.error('Usage: node processPastBurns.js <requestId>');
  process.exit(1);
}

const lpPublicSpendKey = process.env.BURN_LP_PUBLIC_SPEND_KEY;
const lpPublicViewKey = process.env.BURN_LP_PUBLIC_VIEW_KEY;

if (!lpPublicSpendKey || !lpPublicViewKey) {
  console.error('Error: BURN_LP_PUBLIC_SPEND_KEY and BURN_LP_PUBLIC_VIEW_KEY env vars are required');
  process.exit(1);
}

(async () => {
  try {
    console.log('Processing burn request:', requestId);

    // Check if burn request exists
    const burnReq = await hub.getBurnRequest(requestId);
    console.log('Burn request found:');
    console.log('  User:', burnReq.user);
    console.log('  LP Vault:', burnReq.lpVault);
    console.log('  wsXMR Amount:', burnReq.wsxmrAmount.toString());
    console.log('  XMR Amount:', burnReq.xmrAmount.toString());
    console.log('  State:', burnReq.state.toString());

    if (burnReq.lpVault.toLowerCase() !== wallet.address.toLowerCase()) {
      console.error('Error: This burn is not for our vault');
      process.exit(1);
    }

    // Generate secret
    const secret = crypto.randomBytes(32);
    const { secretHash } = await computeSecretHash(secret);

    console.log('Generated secret hash:', secretHash);
    console.log('Secret (SAVE THIS!):', '0x' + Buffer.from(secret).toString('hex'));

    // Call proposeHash
    console.log('Calling proposeHash...');
    const tx = await hub.proposeHash(requestId, secretHash, lpPublicSpendKey, lpPublicViewKey);
    console.log('Transaction sent:', tx.hash);

    const receipt = await tx.wait();
    console.log('Transaction confirmed in block:', receipt.blockNumber);
    console.log('✅ Hash proposed successfully!');
    console.log('');
    console.log('IMPORTANT: Save this secret for finalization:');
    console.log('Secret:', '0x' + Buffer.from(secret).toString('hex'));

  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
})();