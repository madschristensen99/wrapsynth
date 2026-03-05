# WrapSynth Solana Deployment Guide

## Prerequisites

### 1. Install Dependencies

```bash
# Install Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source $HOME/.cargo/env

# Install Solana CLI
sh -c "$(curl -sSfL https://release.solana.com/stable/install)"
export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"

# Install Anchor
cargo install --git https://github.com/coral-xyz/anchor avm --locked --force
avm install latest
avm use latest

# Verify installations
solana --version
anchor --version
```

### 2. Setup Solana Wallet

```bash
# Generate a new keypair (or use existing)
solana-keygen new --outfile ~/.config/solana/id.json

# Check your public key
solana address

# For devnet testing, get SOL from faucet
solana airdrop 2 --url devnet
```

### 3. Install Node Dependencies

```bash
cd solana
npm install
```

## Build the Program

```bash
# Build the Anchor program
anchor build

# This generates:
# - target/deploy/wsxmr_solana.so (program binary)
# - target/idl/wsxmr_solana.json (IDL for client integration)
# - target/types/wsxmr_solana.ts (TypeScript types)
```

## Testing

### Run Tests on Localnet

```bash
# Start local validator (in separate terminal)
solana-test-validator

# Run tests
anchor test --skip-local-validator
```

### Run Tests on Devnet

```bash
# Configure for devnet
solana config set --url devnet

# Run tests
anchor test --provider.cluster devnet
```

## Deployment

### Deploy to Devnet

```bash
# Set cluster to devnet
solana config set --url devnet

# Ensure you have enough SOL
solana balance
# If needed: solana airdrop 2

# Deploy the program
anchor deploy --provider.cluster devnet

# Note the Program ID that gets printed
# Update Anchor.toml with this Program ID
```

### Deploy to Mainnet-Beta

⚠️ **WARNING**: Only deploy to mainnet after thorough testing and security audits!

```bash
# Set cluster to mainnet
solana config set --url mainnet-beta

# Ensure you have enough SOL for deployment (~5-10 SOL)
solana balance

# Deploy the program
anchor deploy --provider.cluster mainnet-beta

# Update Anchor.toml with the mainnet Program ID
```

## Post-Deployment Setup

### 1. Initialize Global State

```typescript
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { WsxmrSolana } from "./target/types/wsxmr_solana";

const provider = anchor.AnchorProvider.env();
anchor.setProvider(provider);
const program = anchor.workspace.WsxmrSolana as Program<WsxmrSolana>;

// Find PDAs
const [globalState] = PublicKey.findProgramAddressSync(
  [Buffer.from("global_state")],
  program.programId
);

const [mintAuthority] = PublicKey.findProgramAddressSync(
  [Buffer.from("mint_authority")],
  program.programId
);

// Initialize
const priceMaxAge = new anchor.BN(300); // 5 minutes
await program.methods
  .initializeGlobal(priceMaxAge)
  .accounts({
    globalState,
    wsxmrMint: wsxmrMintPubkey,
    mintAuthority,
    admin: provider.wallet.publicKey,
    systemProgram: SystemProgram.programId,
    tokenProgram: TOKEN_PROGRAM_ID,
    rent: anchor.web3.SYSVAR_RENT_PUBKEY,
  })
  .rpc();
```

### 2. Create LP Vault

```typescript
const lpKeypair = // Load LP keypair
const collateralMint = // Your collateral token mint

const [vault] = PublicKey.findProgramAddressSync(
  [
    Buffer.from("vault"),
    lpKeypair.publicKey.toBuffer(),
    collateralMint.toBuffer(),
  ],
  program.programId
);

await program.methods
  .createVault(collateralMint)
  .accounts({
    vault,
    lp: lpKeypair.publicKey,
    systemProgram: SystemProgram.programId,
  })
  .signers([lpKeypair])
  .rpc();
```

### 3. Deposit Collateral

```typescript
await program.methods
  .depositCollateral(new anchor.BN(amount))
  .accounts({
    vault,
    globalState,
    lpCollateralAccount,
    vaultCollateralAccount,
    lp: lpKeypair.publicKey,
    tokenProgram: TOKEN_PROGRAM_ID,
  })
  .signers([lpKeypair])
  .rpc();
```

## Configuration

### Update Program ID

After deployment, update `Anchor.toml`:

```toml
[programs.devnet]
wsxmr_solana = "YOUR_DEPLOYED_PROGRAM_ID"

[programs.mainnet]
wsxmr_solana = "YOUR_DEPLOYED_PROGRAM_ID"
```

Also update `lib.rs`:

```rust
declare_id!("YOUR_DEPLOYED_PROGRAM_ID");
```

Then rebuild:

```bash
anchor build
anchor deploy
```

### Pyth Oracle Configuration

The program uses Pyth Network for price feeds:

**Devnet Pyth Program**: `gSbePebfvPy7tRqimPoVecS2UsBvYv46ynrzWocc92s`
**Mainnet Pyth Program**: `FsJ3A3u2vn5cTVofAjvy6y5kwABJAqYWpe4975bi2epH`

**Price Feed IDs**:
- XMR/USD: `46b8cc9347f04391764a0361e0b17c3ba394b001e7c304f7650f6376e37c321d`
- ETH/USD: `31491744e2dbf6df7fcf4ac0820d18a609b49076d45066d3568424e62f686cd1`

## Monitoring & Maintenance

### Check Program Status

```bash
# Get program info
solana program show YOUR_PROGRAM_ID

# Check account data
solana account YOUR_PROGRAM_ID
```

### Upgrade Program

```bash
# Build new version
anchor build

# Upgrade (requires upgrade authority)
anchor upgrade target/deploy/wsxmr_solana.so --program-id YOUR_PROGRAM_ID
```

### Close Program (Devnet Only)

```bash
# Close program and reclaim SOL
solana program close YOUR_PROGRAM_ID --bypass-warning
```

## Security Checklist

Before mainnet deployment:

- [ ] Complete security audit by professional firm
- [ ] Extensive testing on devnet with real scenarios
- [ ] Economic modeling and stress testing
- [ ] Verify all PDAs and account constraints
- [ ] Test liquidation scenarios
- [ ] Verify Pyth oracle integration
- [ ] Test timeout and slashing mechanisms
- [ ] Verify secp256k1 cryptography
- [ ] Set up monitoring and alerting
- [ ] Prepare incident response plan
- [ ] Legal and regulatory review
- [ ] Bug bounty program

## Troubleshooting

### Build Errors

```bash
# Clean and rebuild
anchor clean
anchor build
```

### Deployment Fails

```bash
# Check SOL balance
solana balance

# Increase compute units if needed
# Add to instruction: .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 })])
```

### Account Size Issues

If accounts are too small, update the `LEN` constants in state files and redeploy.

## Resources

- [Anchor Documentation](https://www.anchor-lang.com/)
- [Solana Documentation](https://docs.solana.com/)
- [Pyth Network](https://pyth.network/)
- [SPL Token Program](https://spl.solana.com/token)

## Support

For issues or questions:
- GitHub Issues: [github.com/wrapsynth/wrapsynth](https://github.com/wrapsynth/wrapsynth)
- Discord: [discord.gg/wrapsynth](https://discord.gg/wrapsynth)
