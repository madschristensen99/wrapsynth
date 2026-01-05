# Monero Stagenet Integration Guide

Complete guide for testing ZeroXMR with real Monero stagenet transactions and proof generation.

## Overview

This guide will help you:
1. Set up a Monero stagenet wallet
2. Get stagenet XMR from faucet
3. Send test transactions
4. Generate real PLONK proofs
5. Test full mint/burn cycle on Gnosis Chain fork

## Prerequisites

### 1. Install Monero CLI Tools

Download from: https://www.getmonero.org/downloads/

```bash
# Extract and add to PATH
tar -xjf monero-linux-x64-v0.18.3.1.tar.bz2
export PATH=$PATH:$(pwd)/monero-x86_64-linux-gnu-v0.18.3.1
```

### 2. Start Monero Wallet RPC (Stagenet)

```bash
# Create wallet directory
mkdir -p ~/stagenet-wallets

# Start wallet RPC on stagenet
monero-wallet-rpc \
  --stagenet \
  --rpc-bind-port 38083 \
  --disable-rpc-login \
  --wallet-dir ~/stagenet-wallets \
  --daemon-address stagenet.community.rino.io:38081
```

Keep this terminal open - the RPC server must stay running.

## Quick Start

### Step 1: Create Stagenet Wallet

```bash
npm run setup:stagenet
```

This interactive script will:
- Connect to your wallet RPC
- Create a new wallet (or restore from seed)
- Show your stagenet address
- Guide you through getting XMR from faucet

**Save your seed phrase!** You'll need it to restore your wallet.

### Step 2: Get Stagenet XMR

Visit the faucet:
- **Primary**: https://stagenet.xmr.ditatompel.com/
- **Alternative**: https://community.rino.io/faucet/stagenet/

1. Enter your stagenet address
2. Complete CAPTCHA
3. Request XMR (usually 10-50 XMR)
4. Wait ~2 minutes for confirmation

### Step 3: Verify Balance

```javascript
const { MoneroWalletIntegration } = require('./scripts/moneroWalletIntegration');

const wallet = new MoneroWalletIntegration();
await wallet.connect();
await wallet.openWallet('zeroxmr-test');
await wallet.getBalance();
```

### Step 4: Send Test Transaction

```javascript
// Send 0.05 XMR to yourself
const tx = await wallet.sendToSelf(0.05);
console.log('TX Hash:', tx.getHash());

// Wait for confirmation (~2 minutes)
```

## Proof Generation Pipeline

### Architecture

```
┌─────────────────┐
│ Stagenet Wallet │
│  (Your TX)      │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Extract Output  │
│ - ECDH amount   │
│ - Public keys   │
│ - Commitment    │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Generate        │
│ Witness         │
│ (~1s, 100MB)    │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Generate PLONK  │
│ Proof           │
│ (3-10min, 32GB) │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Submit to       │
│ Gnosis Chain    │
│ (~$0.0006)      │
└─────────────────┘
```

### Implementation Status

✅ **Completed:**
- Monero wallet RPC integration (monero-ts)
- Stagenet wallet setup script
- Transaction sending and monitoring
- Gnosis Chain fork testing with real Aave V3

🚧 **In Progress:**
- Extract ECDH encrypted amounts from raw transactions
- Generate witness from transaction data
- PLONK proof generation (requires proving server)

⏳ **TODO:**
- LP functionality for Uniswap V3 pool
- Oracle service to post transaction outputs
- End-to-end integration test with real proofs

## Manual Testing Workflow

### 1. Create and Fund Wallet

```bash
# Start wallet RPC
monero-wallet-rpc --stagenet --rpc-bind-port 38083 --disable-rpc-login --wallet-dir ~/stagenet-wallets

# In another terminal
npm run setup:stagenet
# Follow prompts to create wallet
# Get XMR from faucet
```

### 2. Send Test Transaction

```javascript
const { MoneroWalletIntegration } = require('./scripts/moneroWalletIntegration');

async function sendTestTx() {
    const wallet = new MoneroWalletIntegration();
    await wallet.connect();
    await wallet.openWallet('zeroxmr-test');
    
    // Send 0.05 XMR to self
    const tx = await wallet.sendToSelf(0.05);
    const txHash = tx.getHash();
    
    console.log('Transaction sent:', txHash);
    console.log('Wait ~2 minutes for confirmation...');
    
    return txHash;
}

sendTestTx();
```

### 3. Extract Proof Data

```javascript
async function extractProofData(txHash) {
    const wallet = new MoneroWalletIntegration();
    await wallet.connect();
    await wallet.openWallet('zeroxmr-test');
    
    // Get transaction details
    const { tx, proofData, txHex } = await wallet.getTransactionProofData(txHash);
    
    // Extract output data for proof generation
    const outputData = await wallet.extractOutputData(txHash, 0);
    
    console.log('Output Data:', outputData);
    
    // This data will be used for:
    // 1. Oracle posting (on-chain verification)
    // 2. Witness generation (off-chain proof)
    
    return outputData;
}
```

### 4. Test on Gnosis Fork

```bash
# Run full integration test
npm run test:gnosis
```

## Stagenet Faucets

### Primary Faucet
- **URL**: https://stagenet.xmr.ditatompel.com/
- **Amount**: 10-50 XMR per request
- **Cooldown**: 24 hours

### Alternative Faucet
- **URL**: https://community.rino.io/faucet/stagenet/
- **Amount**: Variable
- **Cooldown**: 24 hours

### Stagenet Block Explorer
- **URL**: https://stagenet.xmrchain.net/
- Track your transactions and confirmations

## Troubleshooting

### Wallet RPC Not Connecting

```bash
# Check if RPC is running
curl http://localhost:38083/json_rpc -d '{"jsonrpc":"2.0","id":"0","method":"get_version"}' -H 'Content-Type: application/json'

# Should return version info
```

### Balance Shows Zero

1. Check if transaction confirmed: https://stagenet.xmrchain.net/
2. Wait for wallet to sync (can take 5-10 minutes)
3. Refresh balance: `await wallet.getBalance()`

### Transaction Stuck

- Stagenet blocks are mined every ~2 minutes
- Transactions need 10 confirmations to unlock (~20 minutes)
- Check block explorer for status

## Next Steps

1. **Set up proving server** (32-64GB RAM)
   - AWS EC2 r5.2xlarge or similar
   - Install snarkjs and circuit files
   - Create proof generation API

2. **Build oracle service**
   - Monitor Monero blockchain
   - Extract transaction outputs
   - Post to Gnosis Chain contract

3. **Create LP pool**
   - Deploy zeroXMR/xDAI Uniswap V3 pool
   - Provide initial liquidity
   - Enable price oracle

4. **End-to-end test**
   - Send stagenet transaction
   - Generate real proof
   - Mint zeroXMR on Gnosis fork
   - Burn and verify collateral return

## Resources

- **Monero Stagenet**: https://stagenet.xmrchain.net/
- **monero-ts Docs**: https://github.com/monero-ecosystem/monero-ts
- **Monero RPC Docs**: https://www.getmonero.org/resources/developer-guides/wallet-rpc.html
- **ZeroXMR Gnosis Tests**: `test/WrappedMonero.gnosis.fork.test.js`

## Support

For issues or questions:
1. Check Monero stagenet status
2. Verify wallet RPC is running
3. Review transaction on block explorer
4. Check Gnosis fork test logs
