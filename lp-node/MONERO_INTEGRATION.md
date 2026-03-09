# Monero Integration Architecture

## Current Status

The LP node uses `monero-rs` for key management and address derivation. For production, Monero transaction operations require one of the following approaches:

## Production Options

### Option 1: External monero-wallet-rpc (Recommended for MVP)
**Pros:**
- Battle-tested, production-ready
- Full Monero protocol support
- Handles all cryptographic complexity
- Automatic wallet scanning and sync

**Cons:**
- Requires separate process
- Need to manage wallet file security

**Implementation:**
```bash
# Start monero-wallet-rpc with your keys
monero-wallet-rpc \
  --rpc-bind-port 18082 \
  --wallet-file /path/to/wallet \
  --password "secure-password" \
  --daemon-address node.moneroworld.com:18089
```

Update `src/monero.rs` to call wallet RPC for:
- `transfer()` - Send XMR
- `get_transfers()` - Scan for incoming XMR
- `get_balance()` - Check wallet balance

### Option 2: Monero Library Integration (Full Rust)
**Required Libraries:**
- `monero-rs` - Core primitives (already added)
- External C++ bindings to Monero's wallet2 library
- OR: Port relevant parts of monero-wallet-rpc to Rust

**What Needs Implementation:**
1. **Output Scanning**
   - Fetch blocks from daemon
   - Decrypt outputs using view key
   - Identify owned outputs
   - Track spent outputs

2. **Transaction Construction**
   - Select unspent outputs (ring members)
   - Construct ring signatures
   - Calculate transaction fees
   - Sign with private spend key
   - Serialize transaction

3. **Transaction Broadcasting**
   - Submit to daemon via RPC
   - Monitor confirmation status

### Option 3: Adaptor Signatures (Advanced)
Based on AthanorLabs/atomic-swap protocol:

**Cryptographic Components:**
- ECDSA adaptor signatures on secp256k1
- Ed25519 operations for Monero keys
- Secret reveal mechanism through signature verification

**References:**
- https://github.com/AthanorLabs/atomic-swap
- https://github.com/comit-network/xmr-btc-swap (Rust implementation)

## Current Implementation

The current `src/monero.rs` provides:
- ✅ Key derivation from private key
- ✅ Address generation
- ✅ Daemon RPC connection
- ⚠️ Transaction construction (placeholder)
- ⚠️ Wallet scanning (placeholder)
- ⚠️ PTLC support (placeholder)

## Recommended Path Forward

### Phase 1: MVP with monero-wallet-rpc
1. Keep current monero-rs for key derivation
2. Add optional monero-wallet-rpc integration
3. Use wallet RPC for all transaction operations
4. Document wallet setup in deployment guide

### Phase 2: Native Rust Implementation
1. Integrate with existing Rust Monero libraries
2. Implement wallet scanning
3. Implement transaction construction
4. Add comprehensive testing

### Phase 3: Adaptor Signatures
1. Study AthanorLabs implementation
2. Implement ECDSA adaptor signatures
3. Add secret reveal mechanism
4. Optimize for gas costs

## Security Considerations

1. **Key Management**
   - Private keys stored in `.env` (encrypted at rest)
   - Consider hardware wallet integration
   - Implement key rotation

2. **Transaction Safety**
   - Verify all outputs before spending
   - Implement proper fee estimation
   - Add transaction confirmation tracking

3. **Network Security**
   - Use authenticated RPC connections
   - Verify daemon responses
   - Implement rate limiting

## Testing Strategy

1. **Stagenet Testing**
   - Use Monero stagenet for testing
   - Test full swap lifecycle
   - Verify secret reveal mechanism

2. **Mainnet Deployment**
   - Start with small amounts
   - Monitor all transactions
   - Implement circuit breakers

## Resources

- [Monero Documentation](https://www.getmonero.org/resources/developer-guides/)
- [AthanorLabs Atomic Swap](https://github.com/AthanorLabs/atomic-swap)
- [COMIT XMR-BTC Swap](https://github.com/comit-network/xmr-btc-swap)
- [Monero RPC Documentation](https://www.getmonero.org/resources/developer-guides/wallet-rpc.html)
