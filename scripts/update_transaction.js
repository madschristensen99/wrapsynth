#!/usr/bin/env node
/**
 * Update transaction_data.json and compute Merkle proof
 * 
 * Usage: node scripts/update_transaction.js <txHash> <blockHeight> <amount> [outputIndex]
 * Example: node scripts/update_transaction.js abc123... 3602960 0.005 0
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const args = process.argv.slice(2);

if (args.length < 3) {
  console.log('Usage: node scripts/update_transaction.js <txHash> <blockHeight> <amount> [outputIndex]');
  console.log('Example: node scripts/update_transaction.js abc123... 3602960 0.005 0');
  process.exit(1);
}

const txHash = args[0];
const blockHeight = parseInt(args[1]);
const amount = parseFloat(args[2]);
const outputIndex = args[3] ? parseInt(args[3]) : 0;

// Load existing data to preserve secretKeyR and recipientAddress
const txDataPath = path.join(__dirname, '..', 'transaction_data.json');
let existingData = {};
if (fs.existsSync(txDataPath)) {
  existingData = JSON.parse(fs.readFileSync(txDataPath, 'utf8'));
}

// Update transaction data
const txData = {
  txHash,
  blockHeight,
  outputIndex,
  secretKeyR: existingData.secretKeyR || "9752c890ed40bfd4285e8a085b0a025c5cc4c2737c4af88068c6329d4435e009",
  recipientAddress: existingData.recipientAddress || "8BuPi2eetgmHxeqirYnrGMQYMTphDviL88ZkfJTACce95Ta48bmAwd9RKmai5nBA7rShtLadXcKwBT8PSjdyo5P4PgAPT23",
  expectedAmount: amount,
  comment: "Update this file with new transaction data. Amount is in XMR."
};

fs.writeFileSync(txDataPath, JSON.stringify(txData, null, 2));
console.log('✅ Updated transaction_data.json');
console.log('   TX Hash:', txHash);
console.log('   Block:', blockHeight);
console.log('   Amount:', amount, 'XMR');

// Compute Merkle proof
console.log('\n📊 Computing Merkle proof...');
try {
  const result = execSync(
    `MONERO_RPC_URL=http://xmr.privex.io:18081/json_rpc node scripts/utils/compute_merkle_proof.js ${blockHeight} ${txHash} ${outputIndex}`,
    { encoding: 'utf8', cwd: path.join(__dirname, '..') }
  );
  
  // Extract proof from output
  const proofMatch = result.match(/TX Merkle Proof:[\s\S]*?Proof: \[([\s\S]*?)\]/);
  const indexMatch = result.match(/Transaction found at index (\d+)/);
  
  if (proofMatch && indexMatch) {
    const proofStr = proofMatch[1];
    const txIndex = parseInt(indexMatch[1]);
    const proofArray = proofStr.split('\n').filter(l => l.includes('0x')).map(l => l.trim().replace(/,$/, ''));
    
    console.log('✅ Merkle proof computed');
    console.log('   TX Index:', txIndex);
    console.log('   Proof length:', proofArray.length);
    
    // Update the mint script
    const mintScriptPath = path.join(__dirname, 'proofGeneration', 'generate_proof_and_mint.js');
    let mintScript = fs.readFileSync(mintScriptPath, 'utf8');
    
    // Find and replace the Merkle proof section
    const merkleProofRegex = /\/\/ Merkle proofs computed from block data[\s\S]*?const txIndex = \d+;/;
    const newMerkleProof = `// Merkle proofs computed from block data\n    // TX Merkle proof from Monero node (block ${blockHeight}, tx index ${txIndex}) - using Keccak256\n    const txMerkleProof = [\n        ${proofArray.join(',\n        ')}\n    ];\n    const txIndex = ${txIndex};`;
    
    if (merkleProofRegex.test(mintScript)) {
      mintScript = mintScript.replace(merkleProofRegex, newMerkleProof);
      fs.writeFileSync(mintScriptPath, mintScript);
      console.log('✅ Updated generate_proof_and_mint.js with Merkle proof');
    } else {
      console.log('⚠️  Could not auto-update mint script. Manual update needed.');
      console.log('\n📝 Add this to generate_proof_and_mint.js:');
      console.log('   txIndex:', txIndex);
      console.log('   txMerkleProof: [');
      console.log('     ' + proofArray.join(',\n     '));
      console.log('   ]');
    }
  }
} catch (e) {
  console.log('⚠️  Could not compute Merkle proof automatically');
  console.log('   Run manually: MONERO_RPC_URL=http://xmr.privex.io:18081/json_rpc node scripts/utils/compute_merkle_proof.js', blockHeight, txHash, outputIndex);
}

console.log('\n✅ Done! Now wait for oracle to post block', blockHeight, 'then run:');
console.log('   npx hardhat run scripts/proofGeneration/generate_proof_and_mint.js --network unichain_testnet');
