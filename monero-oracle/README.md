# Monero Oracle Service

A Rust service that synchronizes Monero blockchain data to the WrapSynth bridge contract on Unichain.

## Overview

The oracle fetches Monero block data and posts Merkle roots to the on-chain contract, enabling trustless verification of Monero transactions for minting wrapped XMR.

### What it does

1. Polls Monero nodes for new blocks
2. Extracts transaction and output data
3. Computes Merkle roots for:
   - Transaction hashes (for tx inclusion proofs)
   - Output data (for amount/key verification)
4. Posts block data to the WrappedMonero contract

## Prerequisites

- Rust 1.75+ (install via [rustup](https://rustup.rs/))
- Access to a Monero node (RPC)
- Unichain RPC endpoint
- Funded oracle wallet

## Installation

```bash
# Clone the repository
git clone https://github.com/wrapsynth/monero-oracle
cd monero-oracle

# Build
cargo build --release
```

## Configuration

The oracle uses the root `.env` file. Make sure you have configured the oracle variables:

```bash
# From the project root, run the setup script:
./scripts/oracle/setup.sh

# Or manually:
cp .env.example .env
# Edit .env and set PRIVATE_KEY, BRIDGE_ADDRESS, etc.
```

### Required Variables

| Variable | Description |
|----------|-------------|
| `PRIVATE_KEY` | Private key of the deployer/oracle account (with 0x prefix) |
| `BRIDGE_ADDRESS` | Address of the WrappedMonero contract |

### Optional Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `UNICHAIN_RPC_URL` | `https://mainnet.unichain.org` | Unichain RPC endpoint |
| `MONERO_RPC_URL` | `http://xmr.privex.io:18081` | Monero node RPC endpoint |
| `POLL_INTERVAL_SECS` | `120` | How often to check for new blocks |
| `RUST_LOG` | `monero_oracle=info` | Log level |

## Usage

```bash
# From project root, use the helper script:
./scripts/oracle/run.sh

# Or manually from monero-oracle directory:
cd monero-oracle
cargo run --release

# Or run the binary directly:
./monero-oracle/target/release/monero-oracle
```

### Running as a systemd service

Create `/etc/systemd/system/monero-oracle.service`:

```ini
[Unit]
Description=Monero Oracle for WrapSynth
After=network.target

[Service]
Type=simple
User=oracle
WorkingDirectory=/opt/hookedMonero/monero-oracle
ExecStart=/opt/hookedMonero/monero-oracle/target/release/monero-oracle
Restart=always
RestartSec=10
EnvironmentFile=/opt/hookedMonero/.env

[Install]
WantedBy=multi-user.target
```

Enable and start:

```bash
sudo systemctl enable monero-oracle
sudo systemctl start monero-oracle
sudo journalctl -u monero-oracle -f  # View logs
```

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Monero Oracle                            │
│                                                              │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐  │
│  │ Monero RPC   │    │   Merkle     │    │  Unichain    │  │
│  │   Client     │───►│   Builder    │───►│   Client     │  │
│  │              │    │              │    │              │  │
│  │ - get_block  │    │ - tx root    │    │ - post block │  │
│  │ - get_txs    │    │ - output     │    │ - verify     │  │
│  │ - outputs    │    │   root       │    │   oracle     │  │
│  └──────────────┘    └──────────────┘    └──────────────┘  │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

## Security Considerations

### For Production

1. **Run your own Monero node** - Don't rely on public nodes
2. **Use multiple nodes** - Query several monerod instances and require consensus
3. **Implement zkTLS** - Add RISC Zero attestations for trustless verification
4. **Monitor the oracle** - Set up alerts for failures or unusual behavior
5. **Secure the private key** - Use hardware security modules (HSM) or secure enclaves

### Trust Model

Currently, the oracle is trusted to post correct data. The roadmap includes:

- [ ] zkTLS integration (RISC Zero) - Prove authentic Monero node responses
- [ ] Multi-node consensus - Require agreement from N/M nodes
- [ ] On-chain fraud proofs - Challenge incorrect posts

## Development

```bash
# Run tests
cargo test

# Run with debug logging
RUST_LOG=monero_oracle=debug cargo run

# Format code
cargo fmt

# Lint
cargo clippy
```

## API Reference

### Contract Interface

The oracle calls these functions on WrappedMonero:

```solidity
// Post a new Monero block
function postMoneroBlock(
    uint256 blockHeight,
    bytes32 blockHash,
    bytes32 txMerkleRoot,
    bytes32 outputMerkleRoot
) external;
```

### Merkle Tree Format

**Transaction Merkle Root:**
- Leaves: Raw transaction hashes (32 bytes each)
- Hash function: SHA-256
- Tree: Binary, duplicate last leaf if odd

**Output Merkle Root:**
- Leaves: `keccak256(abi.encodePacked(txHash, outputIndex, ecdhAmount, outputPubKey, commitment))`
- Hash function: SHA-256 for internal nodes
- Tree: Binary, duplicate last leaf if odd

## Troubleshooting

### "Oracle has no ETH for gas"

Fund the oracle address with ETH on Unichain:

```bash
# Check balance
cast balance <ORACLE_ADDRESS> --rpc-url https://mainnet.unichain.org
```

### "Wallet is not the oracle"

The contract's oracle address doesn't match your wallet. Either:
1. Use the correct private key
2. Call `transferOracle()` from the current oracle

### "Monero RPC error"

The Monero node is unreachable. Check:
1. Node URL is correct
2. Node is running and synced
3. RPC port is open

### Blocks posting slowly

Increase gas price or check Unichain network congestion:

```bash
# Check current gas price
cast gas-price --rpc-url https://mainnet.unichain.org
```

## License

MIT
