# Seed-Based Key Management Implementation

## Overview

WrapSynth now uses **MoneroSwap's encrypted seed storage approach** instead of signature-derived secrets. This provides better security against EIP-7702/EIP-1271 concerns while maintaining excellent UX.

## Why We Changed

### Previous Approach (Signature-Based)
```javascript
// ❌ Vulnerable to EIP-7702
signature = await signMessage(message);
secret = keccak256(signature);  // Not truly secret with smart accounts
```

**Problem:** With EIP-7702, accounts can delegate to smart contracts, meaning:
- Multiple parties might generate the same signature
- Signatures are no longer "secrets only you know"
- EIP-1271 allows contract-based signature validation

### New Approach (Seed-Based)
```javascript
// ✅ EIP-7702 safe
seedPhrase = generateMnemonic();  // User-controlled secret
keys = deriveKeysFromSeed(seedPhrase);
commitment = keccak256(publicKey);
```

**Benefits:**
- ✅ Seed phrases are true user-controlled secrets
- ✅ Independent of wallet implementation
- ✅ Works with EOAs and smart accounts
- ✅ Future-proof for account abstraction

## Architecture

### Two-Layer Encryption

**Layer 1: Browser Key (IndexedDB)**
- Non-extractable AES-GCM-256 key
- Stored in IndexedDB
- Never leaves the browser
- Survives page refreshes

**Layer 2: Signature Key**
- Derived from wallet signature
- Used to encrypt the IV
- Requires user interaction to decrypt

### Storage Format

```
localStorage key: "wrapsynth/{publicSpendKey}/{userAddress}"
localStorage value: "v2:{encryptedIV}:{encryptedSeed}"
```

### Encryption Flow

```
1. User generates/inputs seed phrase
2. Generate random IV
3. Encrypt seed with browserKey + IV → encryptedSeed
4. Request user signature
5. Derive sigKey from signature
6. Encrypt IV with sigKey → encryptedIV
7. Store: "v2:{encryptedIV}:{encryptedSeed}"
```

### Decryption Flow

```
1. Retrieve encrypted data from localStorage
2. Request user signature (same message as encryption)
3. Derive sigKey from signature
4. Decrypt encryptedIV → IV
5. Decrypt encryptedSeed with browserKey + IV → seed
6. Derive keys from seed
```

## Security Model

### Attack Scenarios

**Scenario 1: Attacker steals localStorage data**
- ❌ Cannot decrypt without browser key (in IndexedDB)
- ❌ Cannot decrypt without user's wallet signature

**Scenario 2: Attacker has browser access**
- ❌ Still needs wallet signature to decrypt IV
- ✅ Browser key is non-extractable

**Scenario 3: Attacker intercepts signature**
- ❌ Signature only decrypts IV, not seed directly
- ❌ Still needs browser key to decrypt seed

**Scenario 4: EIP-7702 smart account**
- ✅ Seed is independent of signature
- ✅ Signature only used for encryption, not as secret itself

### Why This Is Secure

1. **Defense in Depth:** Requires BOTH browser access AND wallet signature
2. **Non-Extractable Keys:** Browser key cannot be exported
3. **Separation of Concerns:** Signature ≠ Secret
4. **Future-Proof:** Works with any wallet type

## Implementation Files

### Core Modules

1. **`seedManager.js`** - Seed generation and key derivation
   - `generateSeedPhrase()` - Create new BIP-39 seed
   - `validateSeedPhrase()` - Validate seed format
   - `generateKeysFromSeed()` - Derive Ed25519 keys (Monero-compatible)
   - `generateCommitment()` - Create on-chain commitment
   - `createKeySet()` - Complete key set for swaps

2. **`seedStorage.js`** - Encrypted storage layer
   - `storeSeed()` - Encrypt and store seed
   - `loadSeed()` - Decrypt and retrieve seed
   - `hasStoredSeed()` - Check if seed exists
   - `deleteSeed()` - Remove stored seed
   - `clearAllSeeds()` - Clear all seeds for user

3. **`seedUI.js`** - User interface components
   - `showSeedGenerationModal()` - Generate new seed with backup
   - `showSeedInputModal()` - Input existing seed or load stored

### Key Derivation (Monero-Compatible)

```javascript
// HD paths (following MoneroSwap)
SPEND_KEY_PATH = "m/44'/128'/0'/0/0";   // Monero coin type
MESSAGE_KEY_PATH = "m/44'/128'/0'/1/0";

// Derive private keys
privateSpendKey = mnemonicToAccount(seed, { path: SPEND_KEY_PATH })
    .getHdKey().privKey % ED25519_L;

// Derive view key from spend key (Monero style)
privateViewKey = keccak256(reverse(privateSpendKey)) % ED25519_L;

// Generate public keys
publicSpendKey = Point.BASE.multiply(privateSpendKey);
publicViewKey = Point.BASE.multiply(privateViewKey);

// Create commitment for contract
commitment = keccak256(abi.encodePacked(px, py));
```

## User Experience

### First-Time User Flow

1. User clicks "Start Mint/Burn"
2. Modal shows: "Generate New Seed Phrase"
3. Display 12 words with backup instructions
4. User confirms backup (checkbox)
5. Verify backup (enter words #3, #7, #11)
6. Ask: "Store encrypted in browser?" (optional)
7. If yes: Request signature → encrypt → store
8. Continue with swap

### Returning User Flow

1. User clicks "Start Mint/Burn"
2. Check if seed stored for this swap
3. If stored: "Load Stored Seed" button
4. User clicks → Request signature → decrypt → continue
5. If not stored: "Enter Seed Phrase" input

### Benefits Over Previous Approach

| Feature | Signature-Based | Seed-Based |
|---------|----------------|------------|
| EIP-7702 Safe | ❌ No | ✅ Yes |
| User Control | ⚠️ Wallet-dependent | ✅ Full control |
| Backup | ❌ Can't backup | ✅ 12 words |
| Recovery | ❌ Lose wallet = lose access | ✅ Seed = full recovery |
| Browser Storage | ❌ Not possible | ✅ Encrypted storage |
| Account Abstraction | ❌ Breaks | ✅ Works |

## Migration Notes

### Updating phantomAgent.js

The `phantomAgent.js` file should be updated to:
1. Remove signature-based secret derivation
2. Accept seed phrase as input
3. Use `seedManager.js` for key generation
4. Use `seedStorage.js` for encrypted storage

### Contract Compatibility

**No contract changes needed!** The contract still:
- Stores `bytes32 claimCommitment`
- Verifies with `Ed25519.scalarMultBase(secret)`
- Compares `keccak256(px, py)` with commitment

The only difference is how the secret is generated:
- **Before:** `secret = keccak256(signature)`
- **After:** `secret = privateSpendKey` (from seed)

## Testing

### Test Cases

1. ✅ Generate new seed phrase
2. ✅ Validate seed phrase format
3. ✅ Derive keys from seed
4. ✅ Generate commitment matching contract
5. ✅ Encrypt and store seed
6. ✅ Decrypt and load seed
7. ✅ Verify backup words
8. ✅ Handle invalid seeds
9. ✅ Handle missing signatures
10. ✅ Clear stored seeds

### Security Tests

1. ✅ Cannot decrypt without signature
2. ✅ Cannot decrypt without browser key
3. ✅ Browser key is non-extractable
4. ✅ Different users = different storage keys
5. ✅ Signature mismatch = decryption fails

## Future Enhancements

1. **Hardware Wallet Support:** Store seed on hardware wallet
2. **Multi-Device Sync:** Encrypted cloud backup (optional)
3. **Seed Splitting:** Shamir's Secret Sharing for recovery
4. **Biometric Unlock:** Use WebAuthn for signature
5. **Auto-Lock:** Clear decrypted seeds after timeout

## References

- MoneroSwap Implementation: `/moneroswap-main/moneroswap/frontend/moneroswap-ui/src/lib/moneroswap.svelte.ts`
- Ed25519 Library: `/contracts/Ed25519.sol`
- VaultManager Contract: `/contracts/VaultManager.sol`
- EIP-7702: Account Abstraction via Delegation
- EIP-1271: Smart Contract Signature Validation
