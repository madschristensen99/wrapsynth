# Monero Oracle Service

Automated service that posts Monero blockchain data to the WrappedMonero contract.

## Overview

The oracle fetches the latest Monero block every 2 minutes and posts it to the WrappedMonero contract on Base Sepolia. This keeps the contract synchronized with the Monero blockchain.

## Setup

### 1. Install Dependencies

Already installed via main `package.json` (axios, dotenv, hardhat, ethers).

### 2. Configure Environment

Add to your `.env` file:

```bash
# Oracle Configuration
ORACLE_PRIVATE_KEY=your_private_key_here
WRAPPED_MONERO_ADDRESS=0x...  # WrappedMonero contract address

# Optional (has defaults)
RPC_URL=https://sepolia.base.org
MONERO_RPC_URL=http://node.monerooutreach.org:18081
INTERVAL_MS=120000  # 2 minutes
```

### 3. Fund Oracle Address

The oracle needs ETH for gas:

```bash
# Get oracle address
node -e "const ethers = require('ethers'); console.log(new ethers.Wallet(process.env.ORACLE_PRIVATE_KEY).address)"

# Send some ETH to this address (0.01 ETH should last ~1000 blocks)
```

### 4. Verify Oracle Role

The oracle address must be set as the oracle in the WrappedMonero contract:

```solidity
// In WrappedMonero constructor or via transferOracle()
oracle = 0x...  // Your oracle address
```

## Usage

### Start Oracle

```bash
node oracle/monero-oracle.js
```

### Run as Background Service

Using PM2:

```bash
# Install PM2
npm install -g pm2

# Start oracle
pm2 start oracle/monero-oracle.js --name monero-oracle

# View logs
pm2 logs monero-oracle

# Stop oracle
pm2 stop monero-oracle

# Restart oracle
pm2 restart monero-oracle
```

Using systemd (Linux):

```bash
# Create service file
sudo nano /etc/systemd/system/monero-oracle.service
```

```ini
[Unit]
Description=Monero Oracle Service
After=network.target

[Service]
Type=simple
User=your_user
WorkingDirectory=/path/to/zeroxmr/spendProof
ExecStart=/usr/bin/node oracle/monero-oracle.js
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

```bash
# Enable and start
sudo systemctl enable monero-oracle
sudo systemctl start monero-oracle

# View logs
sudo journalctl -u monero-oracle -f
```

## How It Works

1. **Poll Monero RPC**: Every 2 minutes, fetches latest block header
2. **Check Contract**: Gets last posted block from WrappedMonero
3. **Post if New**: If Monero block is newer, posts to contract
4. **Repeat**: Continues polling indefinitely

## Gas Costs

- **Per block post**: ~160,000 gas (~$0.00016 on Base Sepolia)
- **Per day**: ~720 blocks × 160k gas = ~115M gas (~$0.12/day)
- **Per month**: ~$3.60

## Monitoring

The oracle logs:
- ✅ Successful block posts
- ⚠️  Already posted blocks (skipped)
- ❌ Errors (RPC failures, gas issues, etc.)

## Troubleshooting

### "Oracle has no ETH for gas"
Fund the oracle address with ETH.

### "Wallet is not the oracle"
The wallet address doesn't match the contract's oracle address. Either:
- Use the correct private key, or
- Call `transferOracle()` on the contract to set the new oracle

### "Monero RPC error"
The Monero node is down or unreachable. Try a different `MONERO_RPC_URL`:
- `http://node.monerooutreach.org:18081` (default)
- `http://node.xmr.to:18081`
- Run your own Monero node

### "Block already posted"
Normal - the block was already posted in a previous run. Oracle will skip it.

## Security

- **Private Key**: Keep `ORACLE_PRIVATE_KEY` secure and never commit to git
- **Oracle Role**: Only the designated oracle can post blocks
- **Validation**: Contract validates block height increases monotonically
- **No Reorgs**: Monero blocks are final after 10 confirmations (~20 min)

## Production Deployment

For production:

1. **Use dedicated oracle server** (VPS, AWS, etc.)
2. **Set up monitoring** (Grafana, Datadog, etc.)
3. **Configure alerts** for oracle downtime
4. **Use hardware wallet** or KMS for oracle key
5. **Run redundant oracles** for high availability
6. **Monitor gas prices** and adjust if needed

## Development

Test the oracle locally:

```bash
# Use short interval for testing
INTERVAL_MS=10000 node oracle/monero-oracle.js
```

## License

MIT
