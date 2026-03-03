# WrapSynth LP Node

A highly concurrent, crash-safe Liquidity Provider (LP) Node for facilitating cross-chain atomic swaps between EVM networks and Monero (XMR).

## Features

- **Crash-Safe**: All critical state is persisted to an embedded `sled` database before broadcasting transactions
- **Concurrent**: Built with Tokio for high-performance async operations
- **Atomic Swaps**: Implements cryptographic PTLC (Point Time Locked Contracts) for trustless swaps
- **EVM Integration**: Uses Alloy for modern, type-safe EVM interactions
- **Monero Integration**: JSON-RPC client for `monero-wallet-rpc`
- **Automatic Recovery**: Resumes incomplete swaps after crashes or restarts
- **Vault Management**: Monitors collateralization ratios and prevents liquidation

## Architecture

### Modules

- **`main.rs`**: Entry point, configuration, and initialization
- **`db.rs`**: Crash-safe persistence using sled embedded database
- **`evm.rs`**: EVM client using Alloy for contract interactions
- **`monero.rs`**: Monero RPC client for wallet operations
- **`events.rs`**: Event listener for EVM contract events
- **`engine.rs`**: State machine orchestration for atomic swaps

### State Machines

#### Burn Flow (User burns wsXMR → LP sends XMR)

1. **Requested**: Detect `BurnRequested` event
2. **Committed**: Generate secret, persist to DB, call `commitBurn()` on EVM
3. **XmrLocked**: Create PTLC on Monero network
4. **SecretRevealed**: Monitor for user claiming XMR and revealing secret
5. **Completed**: Call `finalizeBurn()` on EVM to unlock collateral

#### Mint Flow (User locks XMR → LP mints wsXMR)

1. **Pending**: Detect `MintInitiated` event
2. **XmrLocked**: Verify user locked XMR on Monero
3. **Ready**: Wait for confirmations, call `setMintReady()` on EVM
4. **XmrClaimed**: Claim XMR using revealed secret
5. **Completed**: Call `finalizeMint()` on EVM

## Prerequisites

### System Requirements

- Rust 1.70+ (stable)
- Access to an EVM node (WebSocket)
- Running `monero-wallet-rpc` instance
- Sufficient collateral in your LP vault

### Monero Wallet Setup

1. Download and install Monero CLI tools
2. Start `monero-wallet-rpc`:

```bash
monero-wallet-rpc \
  --rpc-bind-port 18082 \
  --wallet-file /path/to/wallet \
  --password "your-password" \
  --disable-rpc-login \
  --daemon-address node.moneroworld.com:18089
```

## Installation

```bash
cd lp-node
cargo build --release
```

## Configuration

Create a `.env` file or set environment variables:

```bash
# Required
EVM_WS_URL=wss://rpc.gnosischain.com/wss
PRIVATE_KEY=0x1234...  # Your LP private key (keep secure!)
VAULT_MANAGER_ADDRESS=0x...  # VaultManager contract address
LP_VAULT_ADDRESS=0x...  # Your LP vault address (same as derived from PRIVATE_KEY)

# Optional
DB_PATH=./lp-node-db  # Database path (default: ./lp-node-db)
MONERO_RPC_URL=http://127.0.0.1:18082/json_rpc  # Monero wallet RPC
PYTH_HERMES_URL=https://hermes.pyth.network  # Pyth price feed API
```

### Gnosis Mainnet Example

```bash
EVM_WS_URL=wss://rpc.gnosischain.com/wss
PRIVATE_KEY=0xYOUR_PRIVATE_KEY_HERE
VAULT_MANAGER_ADDRESS=0xYOUR_DEPLOYED_VAULT_MANAGER
LP_VAULT_ADDRESS=0xYOUR_LP_ADDRESS
MONERO_RPC_URL=http://127.0.0.1:18082/json_rpc
PYTH_HERMES_URL=https://hermes.pyth.network
```

## Running

```bash
# With environment variables
export EVM_WS_URL=wss://...
export PRIVATE_KEY=0x...
# ... other vars

cargo run --release

# Or with .env file
cargo install dotenv-cli
dotenv cargo run --release
```

## Safety Features

### Crash Recovery

The LP node persists all critical state to the database **before** broadcasting transactions:

1. **Secret Generation**: Secrets for PTLCs are written to DB before calling `commitBurn()`
2. **Transaction Tracking**: All transaction hashes and state transitions are persisted
3. **Automatic Resume**: On restart, the engine resumes all incomplete swaps

### Timeout Protection

- **Burn Timeout**: 24 hours for LP to reveal secret (enforced by smart contract)
- **Safety Margin**: LP finalizes 6 hours before deadline to prevent slashing
- **Mint Timeout**: User-specified timeout for mint operations

### Collateral Management

- **Health Monitoring**: Checks vault collateralization ratio every 5 minutes
- **Target Ratio**: Maintains ≥150% collateralization
- **Liquidation Alert**: Warns when ratio drops below 120%

## Error Handling

The LP node uses robust error handling:

- **No Panics**: All network and DB operations use `Result` types
- **Graceful Degradation**: Failed operations are logged and retried
- **Transaction Retry**: Automatic nonce management and retry logic

## Monitoring

### Logs

The node outputs structured logs:

```
INFO WrapSynth LP Node starting...
INFO Configuration loaded
INFO LP Vault Address: 0x...
INFO Database initialized
INFO EVM client initialized
INFO Monero client initialized
INFO Monero wallet address: 4...
INFO LP Node is running
```

### Database Stats

Access database statistics programmatically:

```rust
let stats = db.stats();
println!("{}", stats);
```

## Production Considerations

### Security

- **Private Key**: Store in secure key management system (e.g., AWS KMS, HashiCorp Vault)
- **RPC Endpoints**: Use authenticated, rate-limited endpoints
- **Firewall**: Restrict Monero RPC access to localhost only

### PTLC Implementation

⚠️ **WARNING**: The current Monero PTLC implementation is simplified for demonstration.

For production:
1. Implement proper Monero PTLC support (currently experimental)
2. Use adaptor signatures for atomic secret reveal
3. Integrate with Monero's cryptographic primitives
4. Implement proper secret extraction from transaction witnesses

### High Availability

- **Database Backups**: Regularly backup the sled database
- **Redundancy**: Run multiple instances with shared state (requires distributed locking)
- **Monitoring**: Integrate with Prometheus/Grafana for metrics

### Gas Management

- **Gas Price**: Implement dynamic gas pricing based on network conditions
- **Nonce Management**: Current implementation includes basic nonce tracking
- **Transaction Retry**: Implement exponential backoff for failed transactions

## Testing

```bash
# Run unit tests
cargo test

# Run with Monero RPC (requires running monero-wallet-rpc)
cargo test -- --ignored

# Check code
cargo clippy
cargo fmt --check
```

## Troubleshooting

### "Failed to connect to Monero wallet"

- Ensure `monero-wallet-rpc` is running
- Check `MONERO_RPC_URL` is correct
- Verify wallet is unlocked

### "Failed to subscribe to events"

- Check `EVM_WS_URL` is a WebSocket endpoint (ws:// or wss://)
- Verify network connectivity
- Ensure VaultManager contract is deployed at the specified address

### "StalePrice error"

- Pyth oracle prices are stale
- The node automatically fetches fresh prices before transactions
- Check `PYTH_HERMES_URL` is accessible

### Database corruption

```bash
# Backup and reset
mv lp-node-db lp-node-db.backup
cargo run --release
```

## License

LGPL-3.0

## Support

For issues and questions, please open a GitHub issue.
