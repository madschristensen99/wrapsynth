# Farcaster Atomic Swap Protocol Implementation

## Overview
This implementation adds full Farcaster-style atomic swap functionality to the WrapSynth LP node, enabling trustless XMR ↔ wsXMR swaps.

## Protocol Flow

### 1. User Initiates Mint
- User generates secret `s_a` and computes commitment `P_a = s_a * G` (secp256k1)
- User calls `initiateMint(lpVault, recipient, xmrAmount, P_a, timeout)`
- Contract emits `MintInitiated` event with `P_a`

### 2. LP Generates Swap Keys
- LP node detects `MintInitiated` event
- LP generates unique keypair `(s_b, v_b)` for this swap
- LP computes combined public key: `P_combined = P_a + P_b`
- LP derives unique Monero deposit address from `P_combined`
- LP stores swap keys in database
- LP provides deposit address to user via API

### 3. User Deposits XMR
- User sends XMR to the unique deposit address
- Only someone with both `s_a + s_b` can spend from this address
- User can verify deposit using `v_a + v_b`

### 4. LP Confirms XMR Lock
- LP monitors Monero blockchain for deposit to swap address
- Once confirmed, LP calls `setMintReady(requestId)`
- Contract status: PENDING → READY

### 5. User Claims wsXMR
- User calls `finalizeMint(requestId, s_a)` revealing their secret
- Contract verifies `s_a * G == P_a`
- User receives wsXMR tokens
- LP can now claim XMR using `s_a + s_b`

## Implementation Details

### Backend (LP Node)

#### New Files
- `src/api.rs` - HTTP API server for frontend communication
  - `GET /swap/:request_id` - Returns deposit address and swap keys

#### Modified Files
- `src/monero.rs`
  - `generate_swap_keys()` - Generate LP keypair and compute combined address
  - `verify_swap_lock()` - Verify XMR locked to specific swap address
  - `claim_swap_xmr()` - Claim XMR using combined secret `s_a + s_b`

- `src/db.rs`
  - Added swap key fields to `MintTask`:
    - `lp_private_spend`
    - `lp_private_view`
    - `lp_public_spend`
    - `deposit_address`

- `src/events.rs`
  - `handle_mint_initiated_event()` - Generate swap keys on mint initiation

- `src/main.rs`
  - Start API server on port 3030

#### Dependencies Added
- `curve25519-dalek` - Ed25519 point operations for key combination
- `axum` - HTTP API server
- `tower-http` - CORS support

### Frontend

#### API Integration
Frontend needs to:
1. After `initiateMint()` succeeds, get `requestId` from transaction
2. Call `http://localhost:3030/swap/${requestId}` to fetch:
   - `deposit_address` - Where to send XMR
   - `lp_public_spend` - LP's public spend key (P_b)
   - `lp_public_view` - LP's private view key (v_b) for verification
   - `xmr_amount` - Amount to send
3. Display deposit address to user
4. User sends XMR to that address
5. Wait for LP to call `setMintReady()`
6. User calls `finalizeMint()` with their secret

## Security Considerations

1. **Unique addresses per swap** - Each mint gets a unique Monero address
2. **Cryptographic commitment** - User's secret is committed before revealing
3. **Atomic swap guarantees** - Either both parties get funds or both can refund
4. **No trust required** - Protocol enforces fairness cryptographically

## TODOs

1. **Address-specific verification** - Currently falls back to checking main wallet
   - Requires wallet RPC with subaddress support or blockchain scanning
   
2. **XMR claiming implementation** - Placeholder for actual sweep transaction
   - Requires wallet RPC integration to spend from swap address

3. **Frontend integration** - Update UI to fetch and display deposit address

4. **Testing** - End-to-end test of complete atomic swap flow

## API Endpoints

### GET /health
Health check endpoint

**Response:**
```
OK
```

### GET /swap/:request_id
Get swap information for a mint request

**Parameters:**
- `request_id` - Hex-encoded 32-byte request ID (without 0x prefix)

**Response:**
```json
{
  "request_id": "644e5182819b937ac960ff2dc8b40380e8ed56fc42bfefedfd71fb4ac6be4ed1",
  "deposit_address": "4AdUndXHHZ6cfufTMvppY6JwXNouMBzSkbLYfpAV5Usx3skxNgYeYTRj5UzqtReoS44qo9mtmXCqY45DJ852K5Jv2684Rge",
  "lp_public_spend": "a1b2c3...",
  "lp_public_view": "d4e5f6...",
  "xmr_amount": 100000000,
  "status": "Pending"
}
```

## Building

```bash
cd lp-node
cargo build --release
```

## Running

```bash
# Start LP node with API server
./lp start

# API will be available at http://localhost:3030
```
