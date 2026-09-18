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
  'event BurnRequested(bytes32 indexed requestId, address indexed user, address indexed lpVault, uint256 wsxmrAmount, uint256 xmrAmount, uint256 rewardCollateral, bytes32 claimCommitment, bytes32 userPublicKey, bytes32 userViewKey)',
  'function proposeHash(bytes32 requestId, bytes32 secretHash, bytes32 lpPublicSpendKey, bytes32 lpPublicViewKey) external',
  'function getBurnRequest(bytes32 requestId) external view returns (tuple(bytes32 requestId, address user, address lpVault, uint256 wsxmrAmount, uint256 xmrAmount, uint256 lockedCollateral, uint256 rewardCollateral, bytes32 secretHash, uint256 deadline, uint256 vaultLiquidationNonce, uint256 normalizedDebtAmount, uint8 status, bytes32 userClaimCommitment, bytes32 userPublicKey, bytes32 userViewKey, uint256 xmrPriceAtRequest, bytes32 revealedSecret))',
];

const provider = new ethers.JsonRpcProvider(RPC_URL, CHAIN_ID);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
const hub = new ethers.Contract(HUB_ADDRESS, HUB_ABI, wallet);

const requestId = process.argv[2];
if (!requestId) {
  console.error('Usage: node processPastBurns.js <requestId>');
  process.exit(1);
}

const lpPrivateSpendKey = process.env.BURN_LP_PRIVATE_SPEND_KEY;
const lpPublicViewKey = process.env.BURN_LP_PUBLIC_VIEW_KEY;

if (!lpPrivateSpendKey) {
  console.error('Error: BURN_LP_PRIVATE_SPEND_KEY env var is required (32-byte hex, 0x prefix optional)');
  process.exit(1);
}
if (!lpPublicViewKey && !process.env.MONERO_VIEW_KEY) {
  console.error('Error: BURN_LP_PUBLIC_VIEW_KEY or MONERO_VIEW_KEY env var is required');
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
    console.log('  State:', burnReq.status.toString());

    if (burnReq.lpVault.toLowerCase() !== wallet.address.toLowerCase()) {
      console.error('Error: This burn is not for our vault');
      process.exit(1);
    }

    // Use LP private spend key as the secret — same value for both EVM commitment and Monero spend key
    const secret = Buffer.from(lpPrivateSpendKey.replace(/^0x/, ''), 'hex');
    const { secretHash } = await computeSecretHash(secret);

    // Derive LP public spend key from the same secret (big-endian, matching EVM)
    const ed = await import('@noble/ed25519');
    const { createHash } = await import('crypto');
    if (!ed.etc.sha512Sync) {
      ed.etc.sha512Sync = (...m) => createHash('sha512').update(Buffer.concat(m)).digest();
    }
    const ED25519_L = 2n ** 252n + 27742317777372353535851937790883648493n;
    const secretBigInt = BigInt('0x' + secret.toString('hex')) % ED25519_L;
    const lpSpendPubPoint = ed.ExtendedPoint.BASE.multiply(secretBigInt);
    const lpPublicSpendKey = '0x' + Buffer.from(lpSpendPubPoint.toRawBytes()).toString('hex');

    // Derive LP public view key
    let lpPublicViewKeyHex;
    if (lpPublicViewKey) {
      lpPublicViewKeyHex = lpPublicViewKey.startsWith('0x') ? lpPublicViewKey : '0x' + lpPublicViewKey;
    } else {
      const viewPriv = Buffer.from(process.env.MONERO_VIEW_KEY, 'hex');
      const viewBigInt = BigInt('0x' + viewPriv.toString('hex')) % ED25519_L;
      const viewPubPoint = ed.ExtendedPoint.BASE.multiply(viewBigInt);
      lpPublicViewKeyHex = '0x' + Buffer.from(viewPubPoint.toRawBytes()).toString('hex');
    }

    console.log('Secret (SAVE THIS!):', '0x' + secret.toString('hex'));
    console.log('Secret hash:', secretHash);
    console.log('LP Public Spend Key:', lpPublicSpendKey);
    console.log('LP Public View Key:', lpPublicViewKeyHex);

    // Call proposeHash
    console.log('Calling proposeHash...');
    const tx = await hub.proposeHash(requestId, secretHash, lpPublicSpendKey, lpPublicViewKeyHex);
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