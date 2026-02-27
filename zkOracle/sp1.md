Here is the comprehensive technical specification for the **SP1 zkVM Guest Program**.

This document defines the exact Rust logic that will be compiled into the zero-knowledge circuit. A relayer will run this program off-chain to generate the proof, and the Gnosis EVM smart contract will verify the program's public outputs.

---

# SP1 Guest Program Specification: Monero Light Client

## 1. System Overview
**Target Environment:** Succinct SP1 zkVM (RISC-V architecture)
**Language:** Rust (`#![no_std]` preferred, but`std` is partially supported in SP1)
**Objective:** Cryptographically prove that a Monero block header satisfies the network's RandomX Proof-of-Work difficulty and extract its state roots for an EVM contract.

## 2. Hard Constraints & ZK Workarounds
Because Monero's RandomX is designed for physical CPUs, the following architectural constraints must be enforced inside the SP1 Rust program:
* **Interpreter Mode Only:** SP1 uses RISC-V. Native RandomX uses hardware JIT (Just-In-Time) compilation and x86 AES-NI instructions. The Rust implementation must be forced into pure software 'Interpreter Mode'.
* **Light Mode (256 MB Cache):** The zkVM cannot allocate the 2GB dataset required for Fast Mode. The program must initialize only the 256 MB cache (Light Mode).
* *(Optimization Note: Because calculating the 256 MB cache using Argon2d inside a zkVM is extremely cycle-heavy, this spec assumes we are proving the PoW using a pre-calculated cache provided as a private input, verified against the current Epoch Seed).*

---

## 3. Data Interfaces

### 3.1 Inputs (Read from Relayer)
The relayer feeds these values into the zkVM using`sp1_zkvm::io::read()`. These are **private inputs**; they do not cost gas on-chain, they are simply the data the circuit needs to do the math.

| Field | Type | Size | Description |
| :--- | :--- | :--- | :--- |
|`seed_hash` |`[u8; 32]`| 32 Bytes | The RandomX epoch seed (changes ~every 4 days) |
|`target_diff` |`u64`| 8 Bytes | Expected network difficulty for this block |
|`block_height` |`u64`| 8 Bytes | Current block height |
|`prev_id` |`[u8; 32]`| 32 Bytes | Hash of the previous block |
|`hashing_blob` |`Vec<u8>`| ~76 Bytes | The serialized Monero block header |
|`tx_root` |`[u8; 32]`| 32 Bytes | Merkle root of standard Monero TXs |
|`output_root` |`[u8; 32]`| 32 Bytes | Bridge-specific Merkle root of stealth outputs |

### 3.2 Outputs (Committed to EVM)
The program exposes these values publicly using`sp1_zkvm::io::commit()`. The SP1 prover wraps these in the final SNARK/STARK proof. The Solidity contract will read these exact bytes to update the Gnosis state.

| Field | Type | Description |
| :--- | :--- | :--- |
|`block_height` |`u64`| Height of the newly verified block |
|`prev_id` |`[u8; 32]` | Must link to the EVM's`latestBlockHash` |
|`block_hash` |`[u8; 32]`| The successfully hashed ID of this block |
|`tx_root` |`[u8; 32]`| Proven Monero transaction root |
|`output_root` |`[u8; 32]`| Proven bridge output root |

---

## 4. Execution Logic (The Rust Program)

The`main.rs` file compiled into the SP1 guest will execute a strict sequence of operations. If any`assert!` fails, the zkVM halts and no proof is generated.

```rust
// pseudo-code for SP1 zkVM Guest (`src/main.rs`)
#![no_std]
sp1_zkvm::entrypoint!(main);

use monero_primitives::block::BlockHeader;
use randomx_rust::{RandomXFlag, RandomXCache, RandomXVM};
use sp1_zkvm::io;

pub fn main() {
    // ---------------------------------------------------------
    // 1. READ INPUTS
    // ---------------------------------------------------------
    let seed_hash: [u8; 32] = io::read();
    let target_diff: u64 = io::read();
    let block_height: u64 = io::read();
    let prev_id: [u8; 32] = io::read();
    let hashing_blob: Vec<u8> = io::read();
    let tx_root: [u8; 32] = io::read();
    let output_root: [u8; 32] = io::read();

    // ---------------------------------------------------------
    // 2. PARSE AND VERIFY HEADER STRUCTURE
    // ---------------------------------------------------------
    // Ensure the hashing blob is valid Monero format and extracts correct prev_id
    let header = BlockHeader::deserialize(&hashing_blob)
        .expect("Invalid Monero bridging blob");
        
    assert_eq!(header.prev_id, prev_id, "Previous block hash mismatch");
    assert_eq!(header.tx_root, tx_root, "TX root mismatch");

    // ---------------------------------------------------------
    // 3. INITIALIZE RANDOMX LIGHT MODE
    // ---------------------------------------------------------
    // Force standard RISC-V interpreter mode (No JIT, No Hardware AES)
    let flags = RandomXFlag::get_flags() | RandomXFlag::FLAG_DEFAULT;
    
    // Initialize the 256MB cache using the epoch seed
    let cache = RandomXCache::allocate();
    cache.init(&seed_hash, flags);

    // Create the Virtual Machine in Light Mode
    let mut rx_vm = RandomXVM::create(flags, &cache, None)
        .expect("Failed to init RandomX VM");

    // ---------------------------------------------------------
    // 4. EXECUTE PROOF OF WORK HASH
    // ---------------------------------------------------------
    // Run the computationally heavy RandomX hash on the block blob
    let block_hash_result = rx_vm.calculate_hash(&hashing_blob);
    
    // ---------------------------------------------------------
    // 5. VERIFY DIFFICULTY
    // ---------------------------------------------------------
    // Convert 256-bit hash to difficulty integer
    let hash_diff = calculate_difficulty(&block_hash_result);
    
    // CRITICAL: Prevent invalid blocks from being proven
    assert!(
        hash_diff >= target_diff,
        "PoW Hash does not meet network target difficulty"
    );

    // ---------------------------------------------------------
    // 6. COMMIT PUBLIC OUTPUTS TO THE EVM
    // ---------------------------------------------------------
    // The proof will mathematically bind these variables to the EVM verifier
    io::commit(&block_height);
    io::commit(&prev_id);
    io::commit(&block_hash_result);     // The new `latestBlockHash`
    io::commit(&tx_root);               // Triggers EVM mint verifications
    io::commit(&output_root);           // Custom stealth output root
}

/// Helper function to convert 256-bit hash byte array to Monero difficulty
fn calculate_difficulty(hash: &[u8; 32]) -> u64 {
    // Standard Monero difficulty math (2^256 - 1) / hash
    // Implementation omitted for brevity
}
```

## 5. Implementation Roadmap for SP1

To successfully compile and run this, the engineering team must follow these steps:

1. **Port`randomx-rs` to pure Rust:** The standard Monero`randomx-rs` crate is actually a C++ wrapper binding to the original RandomX C++ code. **You cannot compile C++ easily into SP1 RISC-V.** You must use a pure-Rust port of RandomX (e.g., parity/randomx-rs or similar) that compiles cleanly without C-FFI.
2. **Cycle Optimization (The "Epoch" Trick):**
   Generating the 256MB cache via Argon2d takes millions of cycles. Because Monero seed hashes only change every 2048 blocks, you should write a separate SP1 program to *just* initialize the Cache and compute a Merkle root of it. Your main Block Verifier program can then just accept the pre-computed Cache as a private input, verify its Merkle root matches the Epoch's known root, and immediately skip to the hash verification. This will reduce proving time from hours to minutes.
3. **Generate Solidity ABI bindings:**
   Run`sp1 build` to create the ELF file. Use`sp1-cli` to automatically generate the`IzkVMVerifier.sol` contract bindings so you can deploy to Gnosis Chain.
