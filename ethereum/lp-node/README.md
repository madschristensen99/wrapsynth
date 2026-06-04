# WrapSynth LP Node

A highly concurrent, crash-safe Liquidity Provider (LP) Node for facilitating cross-chain atomic swaps between EVM networks and Monero (XMR).

## 🚀 Quick Start

### 1. Install Dependencies

```bash
cd lp-node
cargo build --release
```

### 2. Configure Your LP Node

The LP node uses `config.toml` for network/contract addresses and `.env` for sensitive data.

**Deployed Contracts (Gnosis Chain Mainnet - June 4, 2026):**
- wsXmrHub (Diamond Proxy): `0x99fde7582653f1e25489f2295747c0dc7510426f`
- wsXMR Token: `0x3ba7ac3206195d278a62c5a388cdcbe25613e448`
- Liquidity Router: `0x214e07a2433bb9bbf5b2833f45cff4de6e83ca15`
- RedStoneOracleFacet: `0xea2a9f6eb1b83fdcea698470ab5c18226f548722`
- VaultFacet: `0xd32478ce6253d985a6fd8135d4764824ce875e78`
- MintFacet: `0x5285f9e81bf65eb77355150f5904a41597a4d58d`
- BurnFacet: `0xd2fe83c65e01a5d2c644ff49952ddd6e3c8850a9`
- LiquidationFacet: `0x48164d7b8a1ac9c001b5926da8b7d374fd50b8d8`
- YieldFacet: `0x453ab67f51d075eb5d1d2cfd8a7719100403bf37`

**Setup using the script:**
```bash
./setup.sh
```

**Or manually create `.env`:**
```bash
cp .env.example .env
# Edit .env and add:
# - PRIVATE_KEY (your LP account private key)
# - LP_VAULT_ADDRESS (your address derived from the private key)
```

### 3. Start Monero Wallet RPC (Production Only)

**For production transaction operations**, run monero-wallet-rpc:

```bash
# Create wallet from your private keys first (one-time setup)
monero-wallet-cli --generate-from-spend-key /path/to/wallet

# Then start wallet RPC
monero-wallet-rpc \
  --rpc-bind-port 18082 \
  --wallet-file /path/to/wallet \
  --password "your-password" \
  --disable-rpc-login \
  --daemon-address node.moneroworld.com:18089 \
  --trusted-daemon
```

**For development/testing**, you can skip this step. The LP node will use placeholders for Monero operations.

### 4. Run the LP Node

```bash
# Start the server
cargo run --release start

# Or use the wrapper script
./lp start
```

The node will:
- Connect to Gnosis Chain via WebSocket
- Listen for mint/burn events on your vault
- Automatically process atomic swaps
- Monitor your vault's collateralization ratio

### CLI Commands

```bash
# Show vault info (collateral, debt, health ratio)
./lp info

# Check vault health status
./lp health

# Show pending mint/burn requests
./lp pending

# Show swap history (last 10 by default)
./lp history
./lp history --limit 20

# Show database statistics
./lp db-stats

# Start the LP server
./lp start
```

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

The LP node uses a two-tier configuration system:

### 1. `config.toml` - Network & Contract Addresses

Contract addresses and network settings are stored in `config.toml`. This file is **committed to git** and contains the deployed contract addresses:

```toml
[gnosis]
chain_id = 100
name = "Gnosis Chain"
ws_url = "wss://rpc.gnosischain.com/wss"
wsxmr_hub = "0x284B1d429b1038Ef186314b1Fb33f76Eb61497E9"
wsxmr_token = "0x31c76171773138215E518C0224b82AC9BE9897b8"
pyth_oracle = "0x2880aB155794e7179c9eE2e38200202908C17B43"
pyth_hermes_url = "https://hermes.pyth.network"

[monero]
rpc_url = "http://127.0.0.1:18082/json_rpc"
network = "mainnet"

[lp_node]
db_path = "./lp-node-db"
log_level = "info"
```

### 2. `.env` - Sensitive Data Only

Private keys and account-specific data go in `.env` (gitignored):

```bash
# Required
PRIVATE_KEY=0x1234...  # Your LP private key (KEEP SECURE!)
LP_VAULT_ADDRESS=0x...  # Your vault address

# Optional
NETWORK=gnosis  # Which network config to use (default: gnosis)
DB_PATH=./lp-node-db  # Override config.toml value
MONERO_RPC_URL=http://127.0.0.1:18082/json_rpc  # Override config.toml
```

### Environment Variables

- `NETWORK`: Choose which network config to use (`gnosis` or `unichain`)
- `CONFIG_PATH`: Path to config file (default: `config.toml`)
- `PRIVATE_KEY`: **Required** - Your LP account private key
- `LP_VAULT_ADDRESS`: **Required** - Your vault address
- `DB_PATH`: Override database path from config.toml
- `MONERO_RPC_URL`: Override Monero RPC URL from config.toml
- `RUST_LOG`: Logging level (error, warn, info, debug, trace)

## Production Deployment

### Prerequisites

1. **Monero Wallet Setup**
   - Install Monero CLI tools from [getmonero.org](https://www.getmonero.org/downloads/)
   - Create wallet from your private spend key
   - Run monero-wallet-rpc (see setup above)

2. **Environment Configuration**
   - Set `MONERO_WALLET_RPC_URL=http://127.0.0.1:18082/json_rpc` in `.env`
   - Ensure wallet RPC is running and synced

3. **Vault Setup**
   - Create vault on VaultManager contract
   - Deposit sufficient collateral (sDAI)
   - Note your vault address

### Running in Production

```bash
# Ensure monero-wallet-rpc is running
# Then start the LP node
cargo run --release start

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

## HTTP API

The LP node exposes an HTTP API for frontend integration and LP management. The API runs on port 8080 by default (configurable in `config.toml`).

### Public Endpoints

#### `GET /health`
Health check endpoint.

**Response:**
```
OK
```

#### `GET /lp/info`
Get LP node information and capacity.

**Response:**
```json
{
  "lp_address": "0x492c...",
  "lp_vault": "0x492c...",
  "monero_network": "mainnet",
  "supported_collateral": ["sDAI"],
  "quote_ttl_seconds": 60,
  "min_xmr_amount": 10000,
  "max_xmr_amount": 1000000000000,
  "current_capacity_xmr": 50000000000,
  "mint_fee_bps": 100,
  "burn_reward_bps": 50,
  "griefing_deposit_wei": "10000000000000000",
  "mint_ready_bond_wei": "10000000000000000",
  "node_version": "0.2.0",
  "uptime_seconds": 123456
}
```

#### `POST /quote/mint`
Request a quote for minting wsXMR.

**Request:**
```json
{
  "xmr_amount": 1000000000000,
  "user_address": "0xabc..."
}
```

**Response:**
```json
{
  "quote_id": "...",
  "lp_vault": "0x492c...",
  "xmr_amount": 1000000000000,
  "wsxmr_amount": 100000000,
  "fee_wsxmr": 1000000,
  "griefing_deposit_wei": "10000000000000000",
  "expires_at": 1740000000,
  "signature": "0x..."
}
```

#### `POST /quote/burn`
Request a quote for burning wsXMR.

**Request:**
```json
{
  "wsxmr_amount": 100000000,
  "user_address": "0xabc..."
}
```

**Response:** Same structure as mint quote.

#### `POST /mint/notify`
Notify the LP that a mint has been initiated on-chain.

**Request:**
```json
{
  "request_id": "0xdead...",
  "tx_hash": "0xcafe..."
}
```

**Response:**
```json
{
  "request_id": "0xdead...",
  "deposit_address": "5...",
  "xmr_amount": 1000000000000,
  "status": "Pending"
}
```

#### `GET /mint/:request_id/status`
Get the status of a mint request.

**Response:**
```json
{
  "request_id": "0xdead...",
  "status": "XmrLocked",
  "xmr_amount": 1000000000000,
  "wsxmr_amount": 100000000,
  "deposit_address": "5...",
  "monero_confirmations": 5
}
```

#### `GET /burn/:request_id/status`
Get the status of a burn request.

**Response:**
```json
{
  "request_id": "0xbeef...",
  "status": "XmrLocked",
  "xmr_amount": 1000000000000,
  "wsxmr_amount": 100000000,
  "monero_txid": "abc123..."
}
```

#### `GET /swap/:request_id`
Get swap information (legacy endpoint).

**Response:**
```json
{
  "request_id": "0xdead...",
  "deposit_address": "5...",
  "lp_public_spend": "...",
  "lp_public_view": "...",
  "xmr_amount": 1000000000000,
  "status": "Pending"
}
```

### Admin Endpoints

All admin endpoints require authentication via `X-Admin-Key` header. Generate the key using:

```bash
echo -n "admin_auth" | openssl dgst -sha256 -hmac "YOUR_SECRET_FROM_CONFIG"
```

#### `POST /admin/start`
Resume accepting new quotes (if paused).

**Headers:**
```
X-Admin-Key: <hmac_signature>
```

#### `POST /admin/pause`
Pause accepting new quotes.

#### `GET /admin/inventory`
Get current inventory and warnings.

**Response:**
```json
{
  "xmr_balance": 5000000000000,
  "xmr_unlocked": 4500000000000,
  "collateral_amount": "1000000000000000000",
  "locked_collateral": "100000000000000000",
  "pending_mints": 2,
  "pending_burns": 1,
  "warnings": ["Low XMR balance"]
}
```

#### `GET /admin/oracle/status`
Get oracle price status.

**Response:**
```json
{
  "last_xmr_price": 39000000000,
  "last_dai_price": 100000000,
  "last_update_timestamp": 1740000000,
  "age_seconds": 45,
  "last_api_fetch": 1740000030,
  "drift_bps": 12
}
```

#### `POST /admin/oracle/force_push`
Force an immediate oracle price update.

**Response:**
```json
{
  "tx_hash": "0x...",
  "xmr_price": 39000000000,
  "dai_price": 100000000
}
```

### Oracle Price Pusher

The LP node can optionally push oracle prices from RedStone API to the on-chain SimpleOracleFacet. Configure in `config.toml`:

```toml
[oracle]
is_price_pusher = true  # Only ONE LP node should have this enabled
push_threshold_bps = 25  # Push if price drifts > 0.25%
max_age_secs = 90  # Push if last update older than 90 seconds
poll_interval_secs = 30  # Check prices every 30 seconds
```

**Important:** Only one LP node per deployment should have `is_price_pusher = true` to avoid transaction conflicts.

The price pusher:
- Fetches XMR and DAI prices from RedStone API every 30 seconds
- Pushes to on-chain oracle if drift > 0.25% or age > 90 seconds
- Prevents `StalePrice` errors during mint/burn operations
- Requires the LP node's EVM address to be set as `priceUpdater` on the SimpleOracleFacet

## License

LGPL-3.0

## Support

For issues and questions, please open a GitHub issue.
