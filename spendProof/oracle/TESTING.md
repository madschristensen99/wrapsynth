# Oracle Testing Guide

## 🎯 **Goal**

Run the oracle continuously on a local Hardhat network, posting Monero stagenet blocks every 2 minutes, and test with real Monero transactions.

## 📋 **Prerequisites**

1. Monero stagenet wallet with balance
2. Node.js and Hardhat installed
3. Terminal access (3 terminals needed)

## 🚀 **Setup Steps**

### **Terminal 1: Start Hardhat Node**

```bash
cd /home/remsee/zeroxmr/spendProof
npx hardhat node
```

This starts a local Ethereum node on `http://localhost:8545`

Leave this running!

### **Terminal 2: Deploy Contracts**

```bash
cd /home/remsee/zeroxmr/spendProof
npx hardhat run scripts/deploy_oracle_test.js --network localhost
```

This will:
- Deploy MockPlonkVerifier
- Deploy MoneroBridge
- Save deployment info to `oracle/deployment.json`
- Print the LP address for testing

**Copy the LP address!** You'll send Monero to this address.

Example output:
```
👤 Test LP Address:
   View Key (A): 0xaaaa...
   Spend Key (B): 0xbbbb...
   LP Address: 0x9f89faaf1495298300ca41edde79c5cc9cb9bf17e1c9ef97acfdc53194f901e1
```

### **Terminal 3: Start Oracle**

```bash
cd /home/remsee/zeroxmr/spendProof
node oracle/monero-oracle.js
```

This will:
- Connect to local Hardhat node
- Connect to Monero stagenet RPC
- Post blocks every 2 minutes
- Compute TX and output Merkle roots

Leave this running!

## 📝 **Testing Flow**

### **1. Send Monero Transaction**

Send Monero to the LP address on **stagenet**:

```bash
# Using monero-wallet-cli
transfer <LP_ADDRESS> <AMOUNT>
```

### **2. Wait for Oracle**

The oracle runs every 2 minutes. Watch Terminal 3 for:

```
[2026-01-05T16:00:00.000Z] 🔍 Checking Monero blockchain...
   Latest Monero block: 1234567
   Hash: 0x...
   Last posted block: 1234566
   📊 New block detected! Fetching full block data...
   Transactions in block: 5
   Computed TX Merkle root: 0x...
   Outputs in block: 0
   Computed Output Merkle root: 0x...
   
📤 Posting block 1234567 to contract...
   TX: 0x...
   ✅ Confirmed in block 123
   Gas used: 160140
```

### **3. Get Transaction Data**

After your transaction is in a posted block, get the data:

```bash
# Get transaction secret key
monero-wallet-cli get_tx_key <TX_HASH>

# Get transaction data
# You'll need: r, txHash, outputIndex, ecdhAmount, outputPubKey, commitment
```

### **4. Generate ZK Proof**

```bash
cd /home/remsee/zeroxmr/spendProof
node scripts/generate_witness.js <TX_DATA>
```

### **5. Submit Proof**

```bash
node scripts/test_on_chain.js
```

## 🔧 **Configuration**

The oracle reads from `oracle/deployment.json` (auto-generated) or environment variables:

```bash
# Optional: Override defaults
export ORACLE_PRIVATE_KEY="0x..."
export BRIDGE_ADDRESS="0x..."
export RPC_URL="http://localhost:8545"
export MONERO_RPC_URL="http://stagenet.community.rino.io:38081"
export INTERVAL_MS="120000"  # 2 minutes
```

## 📊 **Monitoring**

Watch for these in Terminal 3:

- ✅ **New blocks posted**: Oracle is working
- ⚠️ **"Already up to date"**: No new blocks (normal)
- ❌ **Errors**: Check Monero RPC connection

## 🐛 **Troubleshooting**

### Oracle won't start
- Check `oracle/deployment.json` exists
- Run deployment script first

### No blocks posting
- Check Monero RPC URL is reachable
- Try: `curl http://stagenet.community.rino.io:38081/json_rpc`

### Out of gas
- Oracle account (Hardhat #0) has 10,000 ETH by default
- Should never run out on local network

## 📝 **Next Steps**

1. ✅ Start all 3 terminals
2. ✅ Send Monero to LP address
3. ✅ Wait for oracle to post block
4. ⚠️ **TODO**: Implement `extractOutputsFromBlock()` with real data
5. ⚠️ **TODO**: Generate Merkle proofs
6. ⚠️ **TODO**: Submit full proof with Merkle verification

## 🎯 **Current Status**

- ✅ Oracle posts blocks with TX Merkle root
- ⚠️ Output Merkle root is placeholder (empty array)
- ⚠️ Need to extract real output data from Monero RPC
- ⚠️ Need to generate Merkle proofs for users

**Ready to test with real Monero stagenet transactions!**
