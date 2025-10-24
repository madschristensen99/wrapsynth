# SVM-XMR Atomic Swaps

A TypeScript server for executing atomic swaps between Solana (USDC) and Monero (XMR) using adaptor signatures and the `stealth_swap` Solana program.

## Quick Start

### Prerequisites
- Node.js 18+
- Monero wallet RPC running locally
- Solana CLI tools

### 1. Monero Wallet Setup
```bash
# Start monero-wallet-rpc (stagenet for testing)
monero-wallet-rpc \
  --stagenet \
  --rpc-bind-port 18082 \
  --wallet-file ~/monero/stagenet.wallet \
  --password your_password \
  --daemon-host stagenet.community.xmr.to \
  --daemon-port 38081 \
  --disable-rpc-login
```

### 2. Start the Server
```bash
cd server
npm install
npm run dev
```

Server runs on `http://localhost:3000`

## API Endpoints

### Create USDC → XMR Swap
```bash
curl -X POST http://localhost:3000/api/swap/create-usdc-to-xmr \
  -H "Content-Type: application/json" \
  -d '{
    "alice": "FwacS7RpnqJbT32eqK4s69NXKrSiDpMxX6FXPGwCDoHi",
    "bob": "FwacS7RpnqJbT32eqK4s69NXKrSiDpMxX6FXPGwCDoHi",
    "usdcAmount": 1000000,
    "xmrAmount": 10000,
    "moneroAddress": "5BxQNRHwkfheiLQwAhMGcQM3h9nw2BJVrMjuxHGYJAKxfaP5Lw3a2wuPcwaLKGD8CVyZZzB9qVK9mrKxBt3MAWgwwLq2Ux1",
    "expiryInHours": 24
  }'
```

### Create XMR → USDC Swap
```bash
curl -X POST http://localhost:3000/api/swap/create-xmr-to-usdc \
  -H "Content-Type: application/json" \
  -d '{
    "alice": "FwacS7RpnqJbT32eqK4s69NXKrSiDpMxX6FXPGwCDoHi",
    "bob": "FwacS7RpnqJbT32eqK4s69NXKrSiDpMxX6FXPGwCDoHi",
    "usdcAmount": 1000000,
    "xmrAmount": 10000,
    "aliceSolana": "FwacS7RpnqJbT32eqK4s69NXKrSiDpMxX6FXPGwCDoHi",
    "expiryInHours": 24
  }'
```

### Record Monero Lock Proof (USDC→XMR only)
> ⚠️ **Deprecated**: This endpoint is now a placeholder. Actual proof verification happens on-chain during redemption via adaptor signatures.

### Redeem Swap
```bash
curl -X POST http://localhost:3000/api/swap/:swapId/redeem \
  -H "Content-Type: application/json" \
  -d '{"adaptorSig": "64-byte-hex-signature"}'
```

### Get Swap Details
```bash
curl http://localhost:3000/api/swap/:swapId
```

## Development Setup

### Solana Devnet
```bash
# Configure for devnet
solana config set --url devnet

# Get devnet SOL
solana airdrop 2

# Get devnet USDC
# Option 1: From solfaucet.com
# Option 2: Mint directly if you have USDC minter
```

### Environment Variables
Copy `.env.example` to `.env` and configure:
```bash
cp .env.example .env
```

Key variables:
- `SOL_RPC_URL=https://api.devnet.solana.com`
- `SOL_KEYPAIR_PATH=/path/to/your/keypair.json`
- `XMR_WALLET_PATH=/path/to/monero.wallet`
- `MONERO_WALLET_RPC=http://localhost:18082/json_rpc`

## Architecture

### Solana Program
- **Program ID**: `G1BVSiFojnXFaPG1WUgJAcYaB7aGKLKWtSqhMreKgA82`
- **Network**: Devnet (mainnet support planned)
- **Features**: HTLC with adaptor signatures

### Swap Types
1. **USDC→XMR**: Alice locks USDC, Bob locks XMR
2. **XMR→USDC**: Bob locks USDC, Alice locks XMR

## Local Monero Testing

### Quick Test
```bash
# Check wallet balance
curl -X POST http://localhost:18082/json_rpc \
  -d '{"jsonrpc":"2.0","id":"0","method":"get_balance"}' \
  -H 'Content-Type: application/json'
```

### Create Test Address
curl http://localhost:3000/api/swap/create-usdc-to-xmr \
  -d '{...}'

## Project Structure
```
svm-xmr/
├── solana-program/          # Anchor program source
├── server/                  # TypeScript server
│   ├── src/
│   │   ├── index.ts        # Main server
│   │   ├── handlers.ts     # API endpoints
│   │   ├── solana-client.ts   # Solana integration
│   │   ├── monero-client.ts   # Monero RPC client
│   │   └── config.ts       # Configuration
│   └── package.json
├── spec.txt               # Simple v1 specification
└── README.md             # This file
```

## Status
- **Version**: 2.0.0 (devnet only)
- **Status**: Production-ready on devnet with full Solana program integration
- **Features**: 
  - ✅ Real USDC transfers to vault accounts
  - ✅ On-chain swap state management  
  - ✅ Transaction signatures and confirmations
  - ✅ Live balance checks
- **Setup**: Configure .env with your paths and run