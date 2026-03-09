# Production Deployment Guide

## Overview

The WrapSynth LP Node is a production-ready server for operating a liquidity provider vault on the WrapSynth protocol. It handles:

- **EVM Operations**: Listening for mint/burn events, managing vault collateral
- **Monero Operations**: Sending/receiving XMR for atomic swaps
- **Atomic Swap Orchestration**: Managing the full swap lifecycle

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    WrapSynth LP Node                        │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌──────────────┐  ┌──────────────┐  ┌─────────────────┐  │
│  │   EVM Client │  │ Monero Client│  │  Swap Engine    │  │
│  │              │  │              │  │                 │  │
│  │ - Events     │  │ - Wallet RPC │  │ - State Machine │  │
│  │ - Txs        │  │ - Scanning   │  │ - Recovery      │  │
│  └──────┬───────┘  └──────┬───────┘  └────────┬────────┘  │
│         │                  │                    │           │
└─────────┼──────────────────┼────────────────────┼───────────┘
          │                  │                    │
          ▼                  ▼                    ▼
   ┌─────────────┐   ┌──────────────┐   ┌──────────────┐
   │   Gnosis    │   │    Monero    │   │     Sled     │
   │   Chain     │   │   Mainnet    │   │   Database   │
   └─────────────┘   └──────────────┘   └──────────────┘
```

## Prerequisites

### System Requirements

- **OS**: Linux (Ubuntu 20.04+ recommended)
- **RAM**: 4GB minimum, 8GB recommended
- **Storage**: 50GB SSD
- **Network**: Stable internet connection

### Software Dependencies

1. **Rust** (1.70+)
   ```bash
   curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
   ```

2. **Monero CLI Tools**
   ```bash
   # Download from https://www.getmonero.org/downloads/
   wget https://downloads.getmonero.org/cli/monero-linux-x64-v0.18.3.1.tar.bz2
   tar -xjf monero-linux-x64-v0.18.3.1.tar.bz2
   sudo cp monero-x86_64-linux-gnu-v0.18.3.1/* /usr/local/bin/
   ```

3. **Node.js** (for contract interactions)
   ```bash
   curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
   sudo apt-get install -y nodejs
   ```

## Setup

### 1. Create Monero Wallet

```bash
# Generate wallet from your private spend key
monero-wallet-cli \
  --generate-from-spend-key /var/lib/monero/lp-wallet \
  --daemon-address node.moneroworld.com:18089

# Follow prompts to enter your private key and set password
```

### 2. Configure Environment

```bash
cd lp-node
cp .env.example .env

# Edit .env with your keys
nano .env
```

Required variables:
```bash
# EVM Configuration
PRIVATE_KEY=0xYOUR_EVM_PRIVATE_KEY
LP_VAULT_ADDRESS=0xYOUR_VAULT_ADDRESS

# Monero Configuration  
MONERO_PRIVATE_KEY=YOUR_MONERO_PRIVATE_KEY_HEX
MONERO_WALLET_RPC_URL=http://127.0.0.1:18082/json_rpc

# Network
NETWORK=gnosis
```

### 3. Build Release Binary

```bash
cargo build --release
```

### 4. Create Systemd Services

**Monero Wallet RPC Service** (`/etc/systemd/system/monero-wallet-rpc.service`):

```ini
[Unit]
Description=Monero Wallet RPC for WrapSynth LP
After=network.target

[Service]
Type=simple
User=wrapsynth
WorkingDirectory=/var/lib/monero
ExecStart=/usr/local/bin/monero-wallet-rpc \
  --rpc-bind-port 18082 \
  --wallet-file /var/lib/monero/lp-wallet \
  --password-file /var/lib/monero/.wallet-password \
  --daemon-address node.moneroworld.com:18089 \
  --trusted-daemon \
  --disable-rpc-login \
  --log-file /var/log/monero/wallet-rpc.log
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

**LP Node Service** (`/etc/systemd/system/wrapsynth-lp.service`):

```ini
[Unit]
Description=WrapSynth LP Node
After=network.target monero-wallet-rpc.service
Requires=monero-wallet-rpc.service

[Service]
Type=simple
User=wrapsynth
WorkingDirectory=/opt/wrapsynth/lp-node
EnvironmentFile=/opt/wrapsynth/lp-node/.env
ExecStart=/opt/wrapsynth/lp-node/target/release/wrapsynth-lp-node start
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

### 5. Start Services

```bash
# Enable and start monero-wallet-rpc
sudo systemctl enable monero-wallet-rpc
sudo systemctl start monero-wallet-rpc

# Wait for wallet to sync
sudo journalctl -u monero-wallet-rpc -f

# Enable and start LP node
sudo systemctl enable wrapsynth-lp
sudo systemctl start wrapsynth-lp

# Monitor logs
sudo journalctl -u wrapsynth-lp -f
```

## Monitoring

### Health Checks

```bash
# Check vault health
./lp health

# View vault info
./lp info

# Check pending operations
./lp pending

# View database stats
./lp db-stats
```

### Logs

```bash
# LP Node logs
sudo journalctl -u wrapsynth-lp -f

# Monero Wallet RPC logs
sudo journalctl -u monero-wallet-rpc -f

# Combined view
sudo journalctl -u wrapsynth-lp -u monero-wallet-rpc -f
```

### Metrics

Monitor these key metrics:

1. **Vault Health Ratio**: Should stay above 150%
2. **Pending Swaps**: Should complete within expected timeframes
3. **Monero Balance**: Ensure sufficient XMR for burns
4. **Collateral Balance**: Ensure sufficient sDAI for mints

## Security

### Key Management

1. **Private Keys**
   - Store `.env` with restricted permissions: `chmod 600 .env`
   - Consider using hardware wallet for EVM operations
   - Backup Monero wallet file securely

2. **Network Security**
   - Use firewall to restrict RPC access
   - Only allow localhost connections to wallet RPC
   - Use VPN for remote management

3. **Monitoring**
   - Set up alerts for low collateral ratio
   - Monitor for unusual transaction patterns
   - Track failed swap attempts

### Backup Strategy

```bash
# Backup database
cp -r lp-node-db lp-node-db.backup.$(date +%Y%m%d)

# Backup Monero wallet
cp /var/lib/monero/lp-wallet* /backup/monero/

# Backup configuration
cp .env /backup/config/
```

## Troubleshooting

### Wallet RPC Connection Failed

```bash
# Check if wallet RPC is running
systemctl status monero-wallet-rpc

# Check wallet sync status
monero-wallet-cli --wallet-file /var/lib/monero/lp-wallet
```

### Low Collateral Ratio

```bash
# Check vault status
./lp health

# Deposit more collateral using contract scripts
cd ../scripts/lpServer
node depositCollateral.js
```

### Stuck Swaps

```bash
# Check database for stuck operations
./lp db-stats

# View pending requests
./lp pending

# Manual intervention may be required
# Check logs for specific error messages
```

## Maintenance

### Updates

```bash
# Pull latest code
git pull

# Rebuild
cargo build --release

# Restart service
sudo systemctl restart wrapsynth-lp
```

### Database Cleanup

```bash
# Stop service
sudo systemctl stop wrapsynth-lp

# Backup database
cp -r lp-node-db lp-node-db.backup

# Clean old data (if needed)
# Database automatically manages itself

# Restart
sudo systemctl start wrapsynth-lp
```

## Support

For issues and questions:
- GitHub Issues: https://github.com/wrapsynth/wrapsynth
- Documentation: See MONERO_INTEGRATION.md for technical details

## License

LGPL-3.0
