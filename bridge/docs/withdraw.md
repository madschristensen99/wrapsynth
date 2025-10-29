# XMR Bridge Withdrawal Direction: Technical Summary

## Context & Current State

### What We've Built So Far

**Direction: Monero → Solana (Deposits)**
- ✅ CLSAG verification on Solana (proves Monero ownership)
- ✅ Verkle tree for proof of absence (prevents double-spends)
- ✅ Key image tracking on Solana
- ✅ Economic security via bonded relayers
- ✅ Challenge mechanism with fraud proofs

**Architecture**:
```
Monero Chain (35M+ spent key images)
    ↓
Verkle Tree (width-256, KZG commitments)
    ↓
Relayer (bonded, updates roots)
    ↓
Solana Program (verifies CLSAG + Verkle proof)
    ↓
Mint wXMR tokens
```

### Files Created

1. **`verkle_xmr_solana_bridge.md`** - Full design document
   - Verkle tree architecture
   - KZG polynomial commitments
   - Economic model
   - Security analysis
   - Implementation roadmap

2. **`verkle_verification.rs`** - Solana program
   - Verkle non-membership verification
   - CLSAG integration
   - Relayer update mechanism
   - Challenge/fraud proof system

---

## The Withdrawal Problem

**Direction: Solana → Monero (Withdrawals)**

User has wXMR on Solana and wants to withdraw to Monero. The challenge:

### Key Differences from Deposits

| Aspect | Deposit (XMR→SOL) | Withdrawal (SOL→XMR) |
|--------|-------------------|----------------------|
| **Proof source** | Monero chain (CLSAG) | Solana chain (burn tx) |
| **Double-spend prevention** | Verkle tree on Solana | ??? |
| **Trust assumptions** | Relayer + challengers | ??? |
| **Recipient privacy** | Preserved (stealth addr) | Must be preserved |
| **Amount hiding** | Already hidden (RingCT) | Must be hidden |

### Core Requirements

1. **Burn wXMR on Solana** - Provably destroy tokens
2. **Prove burn to Monero** - Cross-chain proof verification
3. **Mint XMR on Monero** - But Monero has no smart contracts!
4. **Privacy preservation** - Can't reveal amounts or recipients
5. **Double-spend prevention** - Can't withdraw same burn twice
6. **Decentralization** - Minimize trust assumptions

---

## Approach Options

### Option 1: Federated Multisig (Simplest, Most Centralized)

**Architecture**:
```
User burns wXMR on Solana
    ↓
Federation of signers monitors Solana
    ↓
M-of-N signers approve withdrawal
    ↓
Send XMR from hot wallet to user's Monero address
```

**Pros**:
- Simple to implement
- Works with Monero's current design
- No protocol changes needed
- Fast withdrawals

**Cons**:
- Trusted federation
- Custodial (signers hold XMR)
- Single point of failure
- Regulatory risk

**Implementation**:
- Solana: Burn instruction records (amount, recipient_monero_addr)
- Signers: Watch Solana, verify burns, coordinate Monero sends
- Security: Requires threshold > 50% honest signers

---

### Option 2: Threshold Signature Scheme (Better Decentralization)

**Architecture**:
```
User burns wXMR on Solana
    ↓
User requests withdrawal (creates request on Solana)
    ↓
Threshold signers (e.g., 100 validators, need 67)
    ↓
Each signer independently verifies burn
    ↓
Signers create threshold signature shares
    ↓
Aggregate to valid Monero transaction
    ↓
Broadcast to Monero network
```

**Key Innovation**: Use **FROST** (Flexible Round-Optimized Schnorr Threshold)
- Threshold Schnorr signatures
- Compatible with Ed25519 (Monero's curve)
- Non-interactive signing (2 rounds)
- No single party can spend alone

**Pros**:
- More decentralized (100+ validators)
- No single point of failure
- Cryptographically secure threshold
- Can slash dishonest signers

**Cons**:
- Complex coordination
- Need 67+ signers online for each withdrawal
- Latency for signature aggregation
- Still some trust in validator set

**Monero Compatibility**:
- Monero uses Ed25519 for signatures ✅
- FROST works on Ed25519 ✅
- Can create valid Monero transactions from threshold shares ✅

---

### Option 3: Optimistic Withdrawals (Fastest, Requires Bonds)

**Architecture**:
```
User burns wXMR + posts withdrawal request
    ↓
Relayer proposes Monero transaction
    ↓
Challenge period (e.g., 1 hour)
    ↓
If no challenges: Relayer executes on Monero
If challenged: Slashed, challenger executes
```

**Mechanism**:
1. User burns wXMR on Solana, posts withdrawal request with destination
2. Bonded relayer proposes Monero tx hash + proof
3. Anyone can challenge if:
   - Relayer didn't send to correct address
   - Relayer sent wrong amount
   - Relayer didn't execute at all
4. If valid challenge: Relayer slashed, challenger executes withdrawal

**Pros**:
- Fast (1 hour vs 7 days)
- Single relayer can service all withdrawals
- Economic security via bonds
- No coordination overhead

**Cons**:
- Relayers need large XMR reserves
- Challenge mechanism requires Solana→Monero state proofs
- Complex fraud proof system

---

### Option 4: ZK-Proof of Burn (Most Trustless, Most Complex)

**Architecture**:
```
User burns wXMR on Solana
    ↓
Generate ZK-SNARK proving:
  - Burned X amount on Solana
  - Burn not previously claimed
  - Recipient is valid Monero address
    ↓
Submit proof to Monero validator
    ↓
Validator verifies SNARK + mints XMR
```

**Problem**: Monero has no smart contracts or ZK verification!

**Possible Solution**: Monero protocol upgrade
- Add SNARK verifier to consensus rules
- Similar to Zcash's Sapling upgrade
- Requires hard fork + community buy-in
- Years of development

**Pros**:
- Fully trustless
- No federation needed
- Cryptographically sound

**Cons**:
- Requires Monero protocol change
- Years of development
- May be philosophically incompatible with Monero

---

## Recommended Approach: Hybrid Model

### Phase 1: Federated Multisig (Launch, 3 months)
- 5-of-7 or 7-of-11 federation
- Known entities (exchanges, Monero core team, foundations)
- Hot wallet for withdrawals
- Manual override for edge cases

### Phase 2: Threshold Signatures (Decentralize, 6 months)
- Expand to 50-100 validators
- Use FROST for threshold signing
- Solana validators can become XMR bridge validators
- Bonds required to participate
- Automatic slashing for misbehavior

### Phase 3: Optimistic Withdrawals (Scale, 12 months)
- Single relayers with large bonds
- Challenge mechanism
- 1-hour withdrawals instead of multi-hour
- Economic security model

---

## Technical Deep Dive: Threshold Signatures with FROST

### Why FROST?

**FROST** (Flexible Round-Optimized Schnorr Threshold Signatures) is ideal because:
1. Works on Ed25519 (Monero's curve) ✅
2. Only 2 rounds of communication ✅
3. Non-interactive threshold (after setup) ✅
4. Any T-of-N threshold ✅
5. Robust to T-1 malicious signers ✅

### Setup Phase (One Time)

```rust
// Each validator generates a secret share
struct ValidatorShare {
    validator_id: u8,
    secret_share: Scalar,     // Their piece of the private key
    public_share: EdwardsPoint, // Their public verification key
}

// Aggregate public key (controls XMR hot wallet)
let aggregate_pubkey = PublicKey::aggregate(&validator_shares);

// This becomes the Monero address holding bridge funds
let monero_bridge_address = aggregate_pubkey.to_monero_address();
```

### Withdrawal Flow

**1. User Burns on Solana**
```rust
pub fn burn_and_request_withdrawal(
    ctx: Context<BurnWXMR>,
    amount: u64,
    monero_destination: [u8; 95], // Monero address (IntegratedAddress)
) -> Result<()> {
    // Burn wXMR tokens
    token::burn(
        ctx.accounts.burn_ctx(),
        amount,
    )?;
    
    // Create withdrawal request
    let request = WithdrawalRequest {
        id: ctx.accounts.withdrawal_counter.next_id(),
        user: ctx.accounts.user.key(),
        amount,
        destination: monero_destination,
        timestamp: Clock::get()?.unix_timestamp,
        status: WithdrawalStatus::Pending,
    };
    
    ctx.accounts.withdrawal_requests.push(request);
    
    Ok(())
}
```

**2. Validators Monitor Solana**
```rust
// Off-chain validator service
loop {
    let pending_withdrawals = solana_client.get_pending_withdrawals().await?;
    
    for withdrawal in pending_withdrawals {
        // Verify burn transaction
        let burn_verified = verify_burn_tx(&withdrawal.id).await?;
        
        if burn_verified {
            // Start FROST signing protocol
            let sig_share = frost_sign_round1(
                &validator.secret_share,
                &withdrawal,
            ).await?;
            
            // Broadcast signature share to other validators
            broadcast_signature_share(sig_share).await?;
        }
    }
    
    sleep(Duration::from_secs(5)).await;
}
```

**3. FROST Signing (2 Rounds)**

**Round 1: Commitment**
```rust
fn frost_sign_round1(
    secret_share: &Scalar,
    message: &[u8],
) -> (Nonce, NonceCommitment) {
    // Each validator generates random nonce
    let nonce = Scalar::random();
    let commitment = nonce * ED25519_BASEPOINT;
    
    (nonce, commitment)
}
```

**Round 2: Response**
```rust
fn frost_sign_round2(
    secret_share: &Scalar,
    nonce: &Scalar,
    commitments: &[NonceCommitment],
    message: &[u8],
) -> SignatureShare {
    // Compute aggregate commitment
    let R = commitments.iter().sum();
    
    // Compute challenge
    let c = hash_to_scalar(&[R.compress(), message]);
    
    // Compute signature share
    let z = nonce + c * secret_share;
    
    SignatureShare { z }
}
```

**Aggregation**:
```rust
fn frost_aggregate(
    signature_shares: &[SignatureShare],
    threshold: usize,
) -> Result<Signature> {
    require!(signature_shares.len() >= threshold);
    
    // Lagrange interpolation in the exponent
    let s = signature_shares
        .iter()
        .enumerate()
        .map(|(i, share)| {
            let lambda = lagrange_coefficient(i, &signature_shares);
            lambda * share.z
        })
        .sum();
    
    Ok(Signature { R, s })
}
```

**4. Construct Monero Transaction**
```rust
fn construct_monero_withdrawal_tx(
    frost_signature: &Signature,
    withdrawal: &WithdrawalRequest,
) -> MoneroTransaction {
    // Build Monero transaction
    let tx = MoneroTransaction {
        version: 2,
        inputs: vec![
            // Input from bridge hot wallet
            MoneroInput {
                key_image: compute_key_image(&frost_signature),
                ring: get_ring_members(), // Decoys
            }
        ],
        outputs: vec![
            // Output to user's address
            MoneroOutput {
                amount: 0, // Hidden via RingCT
                destination: withdrawal.destination,
                commitment: pedersen_commit(withdrawal.amount),
            }
        ],
        rct_signatures: RingCTSignatures {
            signature: frost_signature.clone(),
            // ... other RingCT components
        },
    };
    
    tx
}
```

**5. Broadcast to Monero**
```rust
async fn broadcast_withdrawal(tx: MoneroTransaction) -> Result<TxHash> {
    let monero_rpc = MoneroRpcClient::new("http://localhost:18081");
    
    let tx_hash = monero_rpc
        .send_raw_transaction(tx.serialize())
        .await?;
    
    Ok(tx_hash)
}
```

**6. Update Solana State**
```rust
pub fn mark_withdrawal_complete(
    ctx: Context<CompleteWithdrawal>,
    withdrawal_id: u64,
    monero_tx_hash: [u8; 32],
) -> Result<()> {
    let request = &mut ctx.accounts.withdrawal_requests
        .get_mut(withdrawal_id)?;
    
    require!(
        request.status == WithdrawalStatus::Pending,
        BridgeError::InvalidStatus
    );
    
    // Verify Monero transaction actually happened
    // (Requires Monero SPV proof or trusted oracles)
    
    request.status = WithdrawalStatus::Completed;
    request.monero_tx_hash = Some(monero_tx_hash);
    
    Ok(())
}
```

---

## Key Technical Challenges

### 1. Monero Transaction Verification

**Problem**: How does Solana know the Monero transaction was executed?

**Options**:

**A) Trusted Oracles**
- 7-of-11 oracles attest to Monero tx confirmation
- Simple but introduces trust
- Oracle bonds can be slashed for false attestations

**B) SPV-Like Proofs**
- Submit Monero block headers to Solana
- Merkle proof of transaction inclusion
- Expensive: Monero blocks are ~80KB each
- Would need to track Monero's chain on Solana

**C) Optimistic Assumption**
- Assume honest threshold signers
- If 67+ signed, transaction must have happened
- Slashing if fraud proven
- Most practical approach

**Recommendation**: Start with (C), upgrade to (A) for additional security.

### 2. FROST Key Generation Ceremony

**Challenge**: Generate distributed private key securely

**DKG (Distributed Key Generation) Protocol**:
```
1. Each validator generates polynomial f_i(x) of degree t-1
2. Broadcasts commitments to coefficients
3. Computes secret shares for other validators
4. Sends shares over secure channels
5. Each validator verifies their share
6. Aggregate public key = sum of f_i(0)·G
```

**Security Requirements**:
- Secure communication channels between validators
- Verifiable secret sharing (VSS)
- Robust to t-1 malicious validators
- Can reshare if validator set changes

### 3. Hot Wallet Management

**Problem**: Bridge needs XMR reserves for withdrawals

**Approaches**:

**A) Fixed Reserve Pool**
- Bridge holds 10,000 XMR initially
- Tops up from deposits
- Risk: Bank run if withdrawals > deposits

**B) Liquidity Providers**
- LPs deposit XMR, earn yield
- Bridge uses LP XMR for withdrawals
- LPs can exit after cooldown
- Balances the float automatically

**C) Hybrid**
- Core reserve (5000 XMR)
- LP reserves (variable)
- Emergency circuit breaker if reserves < threshold

**Recommendation**: Hybrid approach with LP incentives.

### 4. Privacy Leakage Concerns

**Issue**: Burn on Solana reveals amount, withdrawal time, recipient address

**Mitigations**:

1. **Batch withdrawals**: Group multiple withdrawals into single Monero tx
2. **Delayed execution**: Random delay before processing (breaks timing analysis)
3. **Amount rounding**: Round to common denominators (1, 10, 100 XMR)
4. **Decoy requests**: Submit fake withdrawal requests (indistinguishable from real)

**Trade-off**: Privacy vs UX (users want fast, exact-amount withdrawals)

---

## Solana Program Structure

### Account Types

```rust
#[account]
pub struct WithdrawalRequest {
    pub id: u64,
    pub user: Pubkey,
    pub amount: u64,
    pub destination: [u8; 95],        // Monero IntegratedAddress
    pub timestamp: i64,
    pub status: WithdrawalStatus,
    pub monero_tx_hash: Option<[u8; 32]>,
    pub challenge_deadline: i64,
}

#[account]
pub struct ValidatorRegistry {
    pub validators: Vec<ValidatorInfo>,
    pub threshold: u8,                // T in T-of-N
    pub total: u8,                    // N in T-of-N
    pub aggregate_pubkey: [u8; 32],   // Controls hot wallet
}

#[account]
pub struct ValidatorInfo {
    pub pubkey: Pubkey,
    pub monero_public_share: [u8; 32],
    pub bonded_amount: u64,
    pub successful_signs: u64,
    pub failed_signs: u64,
    pub is_active: bool,
}

#[account]
pub struct BridgeReserves {
    pub total_xmr_locked: u64,        // On Monero side
    pub total_wxmr_supply: u64,       // On Solana side
    pub pending_withdrawals: u64,
    pub completed_withdrawals: u64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub enum WithdrawalStatus {
    Pending,           // Waiting for signatures
    Signing,           // FROST protocol in progress
    Broadcasting,      // Submitted to Monero network
    Confirming,        // Waiting for Monero confirmations
    Completed,         // Done
    Failed,            // Error occurred
    Challenged,        // Under dispute
}
```

### Key Instructions

```rust
#[program]
pub mod xmr_withdrawal {
    // 1. User requests withdrawal
    pub fn request_withdrawal(
        ctx: Context<RequestWithdrawal>,
        amount: u64,
        destination: [u8; 95],
    ) -> Result<()>;
    
    // 2. Validator submits signature share
    pub fn submit_signature_share(
        ctx: Context<SubmitSignature>,
        withdrawal_id: u64,
        signature_share: [u8; 32],
        round: u8,
    ) -> Result<()>;
    
    // 3. Coordinator aggregates signatures
    pub fn aggregate_signatures(
        ctx: Context<AggregateSignatures>,
        withdrawal_id: u64,
        signature_shares: Vec<[u8; 32]>,
    ) -> Result<Signature>;
    
    // 4. Update status after Monero broadcast
    pub fn mark_withdrawal_broadcasted(
        ctx: Context<MarkBroadcasted>,
        withdrawal_id: u64,
        monero_tx_hash: [u8; 32],
    ) -> Result<()>;
    
    // 5. Confirm Monero transaction
    pub fn confirm_withdrawal(
        ctx: Context<ConfirmWithdrawal>,
        withdrawal_id: u64,
        monero_proof: MoneroTxProof,
    ) -> Result<()>;
    
    // 6. Challenge fraudulent withdrawal
    pub fn challenge_withdrawal(
        ctx: Context<ChallengeWithdrawal>,
        withdrawal_id: u64,
        fraud_proof: WithdrawalFraudProof,
    ) -> Result<()>;
}
```

---

## Economic Model

### For Validators

**Revenue**:
- Withdrawal fee: 0.1% of amount
- Distributed among T signers who participated
- Example: 100 XMR withdrawal = 0.1 XMR fee / 67 validators = ~0.0015 XMR each

**Costs**:
- Bond requirement: 100 SOL per validator
- Infrastructure: Monero node + Solana node + signing service
- Coordination overhead

**Slashing**:
- Failed to sign when online: -1 SOL
- Signed invalid withdrawal: -50 SOL (50% of bond)
- Colluded theft attempt: -100 SOL (full bond)

### For Users

**Fees**:
- Withdrawal fee: 0.1% + 0.0001 XMR base fee
- Solana transaction fee: ~0.00001 SOL
- Total: ~$0.10 - $1.00 depending on amount

**Speed**:
- Phase 1 (Federation): 15-30 minutes
- Phase 2 (FROST): 1-2 hours
- Phase 3 (Optimistic): 10-60 minutes

---

## Security Analysis

### Threat Model

**1. Validator Collusion**
- **Attack**: T validators collude to steal hot wallet
- **Defense**: 
  - Require > 66% threshold
  - Economic cost > potential gain
  - Slashing destroys attacker funds
  - Reputation damage

**2. Eclipse Attack**
- **Attack**: Isolate honest validators, present false Solana state
- **Defense**:
  - Validators run multiple Solana RPC nodes
  - Cross-check state with multiple providers
  - Slashing if caught

**3. Front-Running**
- **Attack**: Validator sees withdrawal, front-runs with their own
- **Defense**:
  - Encrypted mempool (if available)
  - Batch processing
  - Round-robin validator selection

**4. Denial of Service**
- **Attack**: Spam withdrawal requests to clog system
- **Defense**:
  - Minimum withdrawal amount (0.1 XMR)
  - Rate limiting per user
  - Priority queue based on fees

### Trust Assumptions

**Phase 1 (Federation)**:
- Trust: 5-of-7 federation members
- Centralization: High
- Risk: Medium (multisig reduces single point of failure)

**Phase 2 (FROST)**:
- Trust: 67-of-100 validators
- Centralization: Medium
- Risk: Low (economic security + threshold cryptography)

**Phase 3 (Optimistic)**:
- Trust: Bonds + challenge mechanism
- Centralization: Low (any bonded party can be relayer)
- Risk: Very Low (cryptoeconomic security)

---

## Implementation Checklist

### Phase 1: Federated Multisig (Months 1-3)

**Month 1: Core Infrastructure**
- [ ] Solana program: Burn + withdrawal requests
- [ ] Monero hot wallet with 7-of-11 multisig
- [ ] Secure key ceremony for federation
- [ ] Basic monitoring dashboard

**Month 2: Off-Chain Services**
- [ ] Validator monitoring service (watches Solana)
- [ ] Monero transaction builder
- [ ] Multisig coordination protocol
- [ ] Alert system for anomalies

**Month 3: Testing & Launch**
- [ ] Testnet deployment (Solana devnet + Monero stagenet)
- [ ] Security audit
- [ ] Bug bounty
- [ ] Gradual mainnet rollout with caps

### Phase 2: FROST Threshold Signatures (Months 4-9)

**Months 4-5: Cryptography**
- [ ] FROST implementation for Ed25519
- [ ] Distributed key generation ceremony
- [ ] Signature aggregation service
- [ ] Test with 10 validators

**Months 6-7: Validator Onboarding**
- [ ] Validator registration program
- [ ] Bonding mechanism
- [ ] Reward distribution
- [ ] Expand to 50 validators

**Months 8-9: Migration & Scaling**
- [ ] Migrate from federation to FROST
- [ ] Expand to 100 validators
- [ ] Performance optimization
- [ ] Economic attack simulations

### Phase 3: Optimistic Withdrawals (Months 10-12)

**Months 10-11: Optimistic Protocol**
- [ ] Challenge mechanism on Solana
- [ ] Fraud proof generation
- [ ] Relayer coordination
- [ ] 1-hour withdrawal path

**Month 12: Polish & Scale**
- [ ] UX improvements (wallet integration)
- [ ] Analytics dashboard
- [ ] Marketing & growth
- [ ] Scale to 1000+ withdrawals/day

---

## Open Questions for Next Session

### Technical
1. **Monero transaction construction**: Can we build valid RingCT transactions from FROST signatures? Need to verify compatibility with Monero's signing algorithm.

2. **Key rotation**: How do we rotate threshold keys when validators change? DKG resharing protocol?

3. **Emergency recovery**: What if >33% validators go offline? Need manual override?

### Economic
1. **Initial reserves**: Who provides the 10,000 XMR hot wallet? DAO? VCs? LPs?

2. **Fee structure**: 0.1% enough to incentivize validators? Too high for users?

3. **Slashing severity**: What's the right balance between punishment and validator participation?

### UX
1. **Withdrawal speed**: Is 1-2 hours acceptable? Can we do better?

2. **Privacy**: Should we force batching for privacy, or let users opt-in?

3. **Failure handling**: How do we communicate failures to users? Automatic retry?

---

## Key Files for Next Session

### To Reference
1. **`verkle_xmr_solana_bridge.md`** - Deposit direction architecture
2. **`verkle_verification.rs`** - Existing Solana program
3. This file (**`xmr_bridge_withdrawal_summary.md`**)

### To Create
1. **`withdrawal_program.rs`** - Solana program for withdrawal logic
2. **`frost_signing.rs`** - FROST threshold signature implementation
3. **`monero_tx_builder.rs`** - Construct Monero transactions from threshold sigs
4. **`validator_service.rs`** - Off-chain validator monitoring service

---

## Quick Reference: FROST Resources

### Papers
- [FROST: Flexible Round-Optimized Schnorr Threshold Signatures](https://eprint.iacr.org/2020/852.pdf)
- [ROAST: Robust Asynchronous Schnorr Threshold Signatures](https://eprint.iacr.org/2022/550.pdf)

### Implementations
- [ZCash FROST (Rust)](https://github.com/ZcashFoundation/frost)
- [FROST for Ed25519](https://github.com/ZcashFoundation/frost/tree/main/frost-ed25519)

### Monero Signing
- [Monero CLSAG Specification](https://www.getmonero.org/resources/research-lab/pubs/MRL-0011.pdf)
- [libsodium Ed25519](https://doc.libsodium.org/public-key_cryptography/public-key_signatures)

---

## Summary

**Deposit Direction (XMR → SOL)**: ✅ Solved via Verkle trees + CLSAG verification

**Withdrawal Direction (SOL → XMR)**: Needs implementation, recommended approach:
1. **Phase 1**: Federated multisig (simple, gets us to market)
2. **Phase 2**: FROST threshold signatures (decentralized, secure)
3. **Phase 3**: Optimistic withdrawals (fast, scalable)

**Core Challenge**: Monero has no smart contracts, so we need off-chain coordination with cryptoeconomic security.

**Key Innovation**: Use FROST threshold signatures on Ed25519 to create valid Monero transactions from decentralized validator set.

**Next Steps**: Implement withdrawal Solana program + FROST signing service.