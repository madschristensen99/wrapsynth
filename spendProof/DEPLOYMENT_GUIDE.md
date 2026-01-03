# Monero Bridge DLEQ - Base Sepolia Deployment Guide

## 🎯 Overview

This guide will help you deploy the Monero Bridge DLEQ-optimized contracts to Base Sepolia testnet.

## ✅ Prerequisites

1. **Node.js** and **npm** installed
2. **Base Sepolia ETH** for gas fees
   - Get from: https://www.coinbase.com/faucets/base-ethereum-goerli-faucet
3. **Wallet private key** with Base Sepolia ETH
4. **(Optional)** BaseScan API key for contract verification

## 📋 Setup Steps

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment

```bash
# Copy the example env file
cp .env.example .env

# Edit .env and add your credentials
nano .env
```

Required variables:
- `PRIVATE_KEY`: Your wallet private key (without 0x prefix)
- `BASE_SEPOLIA_RPC_URL`: RPC endpoint (default: https://sepolia.base.org)
- `BASESCAN_API_KEY`: (Optional) For contract verification

### 3. Deploy Contracts

```bash
npx hardhat run scripts/deploy_base_sepolia.js --network baseSepolia
```

This will deploy:
1. **PlonkVerifier** - Verifies PLONK proofs on-chain
2. **MoneroBridgeDLEQ** - Main bridge contract with DLEQ verification

### 4. Verify Contracts (Optional)

After deployment, verify on BaseScan:

```bash
# Verify PlonkVerifier
npx hardhat verify --network baseSepolia <VERIFIER_ADDRESS>

# Verify MoneroBridgeDLEQ
npx hardhat verify --network baseSepolia <BRIDGE_ADDRESS> <VERIFIER_ADDRESS>
```

## 📊 Deployment Output

The deployment script will:
- ✅ Deploy both contracts
- ✅ Save addresses to `deployment_base_sepolia.json`
- ✅ Print verification commands
- ✅ Provide BaseScan explorer links

## 🧪 Testing on Base Sepolia

### Run Local Tests First

```bash
# Run all Hardhat tests
npx hardhat test

# Run DLEQ proof tests
node scripts/test_all_with_dleq.js
```

### Submit Proof to Testnet

After deployment, you can submit a real Monero proof:

```bash
# Generate proof for a transaction
node scripts/test_circuit.js

# The proof will be in proof.json and public.json
# Use these to call the bridge contract
```

## 📁 Important Files

- `hardhat.config.js` - Network configuration
- `scripts/deploy_base_sepolia.js` - Deployment script
- `deployment_base_sepolia.json` - Deployed addresses
- `.env` - Your private credentials (DO NOT COMMIT!)

## 🔒 Security Notes

1. **NEVER commit your `.env` file**
2. Use a **test wallet** for deployment
3. This is **experimental software** - not audited for production
4. Base Sepolia is a **testnet** - for testing only

## 🌐 Useful Links

- Base Sepolia Explorer: https://sepolia.basescan.org
- Base Sepolia Faucet: https://www.coinbase.com/faucets/base-ethereum-goerli-faucet
- Base Docs: https://docs.base.org

## 📊 Contract Details

### Circuit Stats
- **Constraints**: 1,167 (99.97% reduction from 3.9M)
- **Proof Generation**: ~3 seconds
- **Proof Verification**: ~300ms on-chain

### Gas Estimates
- PlonkVerifier deployment: ~2-3M gas
- MoneroBridgeDLEQ deployment: ~1-2M gas
- Proof verification: ~300-400k gas per proof

## 🎉 Next Steps

After deployment:
1. Test proof submission on testnet
2. Monitor gas costs
3. Test fraud detection (wrong keys, amounts, addresses)
4. Prepare for mainnet deployment

## 🐛 Troubleshooting

### "Insufficient funds"
- Get more Base Sepolia ETH from faucet
- Check your wallet balance

### "Invalid nonce"
- Reset your account in MetaMask
- Or wait a few minutes and try again

### "Contract verification failed"
- Make sure you have BASESCAN_API_KEY in .env
- Check that constructor arguments match deployment

## 📞 Support

For issues or questions, check:
- GitHub Issues
- Contract tests in `/test`
- Circuit documentation in `DLEQ_OPTIMIZATION_PLAN.md`
