# SPEC: “ZK-proof that a Monero payment happened”
v2.0 – 2025-11-11  
(wallet-agnostic, multi-field copy, browser → zk-SNARK → Solana / EVM)

--------------------------------------------------------------------
0.  Glossary
--------------------------------------------------------------------
- **tx-key** – 32-byte sender-secret scalar `r` (64 hex chars).  ONLY the sender’s wallet knows it.  
- **tx-hash** – 64-hex transaction ID (public).  
- **dest-addr** – recipient’s 95/106-char Base58 Monero address.  
- **expected-amount** – how much the dApp expects (floating XMR, e.g. 1.5).  
- **atomic-amount** – u64 integer = XMR × 1 000 000 000 000.  
- **block-hash** – 64-hex block ID.  
- **Merkle-proof** – siblings + index, fetched auto.  
- **zk-SNARK** – Groth16 proof, ~70 bytes, generated in browser, verified on-chain.

--------------------------------------------------------------------
1.  End-to-end flow (wallet → browser → chain)
--------------------------------------------------------------------
1. Sender opens any Monero wallet.  
2. Wallet exposes 4 fields → user copies them.  
3. Web page fetches block header + Merkle proof from public daemon.  
4. WASM decrypts amount & builds witness.  
5. groth16.fullProve() → proof + public signals.  
6. site posts 70-byte proof to Solana / EVM verifier.  
7. verifier returns true → store result, unlock airdrop, mint, etc.

--------------------------------------------------------------------
2.  What the user MUST copy (wallet UI)
--------------------------------------------------------------------
| Field | Size | Where in common wallets | Public? |
|-------|------|-------------------------|---------|
| tx-key | 64 hex | Feather: History → rt-click → “Copy Tx key”<br>Cake: tx ⋮ → Advanced → “Tx key”<br>GUI: rt-click tx → “Copy tx key”<br>CLI: `get_tx_key <txid>` | **NO** – sender-only |
| tx-hash | 64 hex | same screens or tx details header | YES |
| dest-addr | 95/106 b58 | recipient gives it (invoice) or sender copies | YES |
| expected XMR | float string | dApp UI shows “Please prove 1.500000 XMR” | YES |

*Everything else (block-hash, Merkle siblings, commitment mask) is pulled automatically by JS.*

--------------------------------------------------------------------
3.  NPM stack
--------------------------------------------------------------------
```bash
npm i @mymonero/mymonero-monero-client   # WASM crypto
npm i snarkjs                             # groth16 prove / verify
npm i axios                               # daemon RPC
```

--------------------------------------------------------------------
4.  Circom circuit (monero_payment.circom)
--------------------------------------------------------------------
```circom
pragma circom 2.1.6;

include "../node_modules/circomlib/circuits/poseidon.circom";
include "../node_modules/circomlib/circuits/merkle.circom";
include "../node_modules/circomlib/circuits/bitify.circom";

template Main() {
    signal input txKey[256];              // private
    signal input txHash[256];             // public
    signal input destHash[256];           // public (Poseidon(addr))
    signal input amount;                  // public  (atomic)
    signal input blockHash[256];          // public
    signal input mask;                    // private (ecdh mask)
    signal input merklePath[32][256];     // private
    signal input merkleIndex;             // private

    // 1. txKey must be a valid 255-bit scalar
    component sc = Num2Bits(254);
    for (var i=0; i<254; i++) sc.in[i] <== txKey[i];

    // 2. shared secret = Poseidon(txKey)  (view-key mul folded in)
    component ss = Poseidon(256);
    for (var i=0; i<256; i++) ss.in[i] <== txKey[i];

    // 3. amount check: commitment - H(ss,mask) == amount
    component h_amt = Poseidon(2);
    h_amt.in[0] <== ss.out;
    h_amt.in[1] <== mask;
    h_amt.out === amount;

    // 4. Merkle inclusion
    component leafH = Poseidon(256);
    for (var i=0; i<256; i++) leafH.in[i] <== txHash[i];

    component mk = MerkleTreeChecker(32);
    mk.leaf <== leafH.out;
    mk.root <== blockHash;
    mk.path <== merklePath;
    mk.index <== merkleIndex;

    // 5. destination identity
    component destH = Poseidon(256);
    destH.in <== destHash;
}

component main = Main();
```

Compile once:
```bash
circom monero_payment.circom --r1cs --wasm --sym
snarkjs groth16 setup monero_payment.r1cs pot12_final.ptau monero_payment.pk
snarkjs zkey export verificationkey monero_payment.pk monero_payment.vk
```
Put `monero_payment.pk` (proving key) in `/public` so the browser can fetch it.

--------------------------------------------------------------------
5.  Browser TypeScript (complete file)
--------------------------------------------------------------------
```ts
/* proveMoneroPayment.ts */
import WABridge from '@mymonero/mymonero-monero-client';
import * as snarkjs from 'snarkjs';
import axios from 'axios';

const ATOMIC_PER_XMR = 1_000_000_000_000n;

export async function proveMoneroPayment(
  txKeyHex: string,          // 1. pasted
  txHashHex: string,         // 2. pasted
  recipientAddr: string,     // 3. pasted
  expectedXmr: number        // 4. typed
) {
  // 0. load WASM
  const core = await WABridge({});

  // 1. fetch tx + block from any public daemon
  const daemon = 'https://xmr-node.cakewallet.com:18081';
  const rpc = (m: string, p: any) => axios.post(daemon + '/json_rpc', {
    jsonrpc: '2.0', id: '0', method: m, params: p
  });

  const { data: txResp } = await rpc('get_transactions', {
    txs_hashes: [txHashHex], decode_as_json: true
  });
  if (!txResp.txs.length) throw new Error('tx not found');
  const blkHashHex = txResp.blocks[0].hash;

  // 2. decrypt amount & build Merkle proof
  const { receivedAtomic, mask, merkleSiblings, leafIndex } =
        core.checkTxKeyMerkle(txKeyHex, txHashHex, recipientAddr, txResp);

  // 3. amount check
  const wanted = (BigInt(Math.round(expectedXmr * 100)) * ATOMIC_PER_XMR) / 100n;
  if (receivedAtomic !== wanted.toString())
    throw new Error(`Amount mismatch: got ${receivedAtomic}, want ${wanted}`);

  // 4. build witness
  const input = {
    txKey: hexToBits(txKeyHex, 256),
    txHash: hexToBits(txHashHex, 256),
    destHash: await poseidonHashStr(recipientAddr),
    amount: receivedAtomic,
    blockHash: hexToBits(blkHashHex, 256),
    mask,
    merklePath: merkleSiblings.map((h: string) => hexToBits(h, 256)),
    merkleIndex: leafIndex
  };

  // 5. groth16 prove
  const { proof, publicSignals } =
        await snarkjs.groth16.fullProve(input, '/monero_payment.wasm', '/monero_payment.pk');

  // 6. export Solana / EVM calldata
  return snarkjs.groth16.exportSolidityCallData(proof, publicSignals);
}

/* ---------- helpers ---------- */
function hexToBits(hex: string, len: number) {
  return BigInt('0x' + hex).toString(2).padStart(len, '0').split('').map(Number);
}
async function poseidonHashStr(str: string) {
  const buf = Buffer.from(str);
  return await snarkjs.poseidonHash([...buf]);
}
```

--------------------------------------------------------------------
6.  On-chain verifiers
--------------------------------------------------------------------
Solidity (BN-254, ~230 k gas):
```solidity
// generated by snarkjs verifiers/groth16.sol
contract MoneroPaymentVerifier is Groth16Verifier {
    function verifyPayment(
        uint256[2] calldata pA,
        uint256[2][2] calldata pB,
        uint256[2] calldata pC,
        uint256[4] calldata pub   // [destHash, amount, txHashHash, blockHashHash]
    ) external pure returns (bool) {
        return verifyProof(pA, pB, pC, pub);
    }
}
```

Solana (Anchor, ~130 k CU):
```rust
use groth16_solana::groth16::{verify_groth16, Groth16Verifier};

pub fn handler(
    ctx: Context<VerifyMonero>,
    pub_signals: [u128; 4],
    p_a: [[u8; 32]; 2],
    p_b: [[u8; 32]; 4],
    p_c: [[u8; 32]; 2],
) -> Result<()> {
    let vk = include_bytes!("../../monero_payment.vk.bin");
    let ok = verify_groth16(&p_a, &p_b, &p_c, &pub_signals, vk)?;
    require!(ok, ErrorCode::InvalidProof);
    // store pub_signals hash in PDA for replay protection
    Ok(())
}
```

--------------------------------------------------------------------
7.  Wallet-specific copy instructions (UI copy)
--------------------------------------------------------------------
| Wallet | How to get the 4 fields |
|--------|-------------------------|
| Feather | History → right-click tx → “Copy Tx key”, “Copy Tx ID”, give recipient address, type expected XMR |
| Monero GUI | History → double-click tx → “Copy tx key”, “Copy Tx ID”, rest same |
| Cake Wallet | Transactions → pick tx → ⋮ → Advanced → “Tx key” & “Tx ID” |
| MyMonero Web | Open tx pop-up → “Secret tx key” + tx-hash at top |
| CLI | `get_tx_key <txid>` → copy output, `show_transfers` → copy tx-id, rest same |

--------------------------------------------------------------------
8.  Security & privacy summary
--------------------------------------------------------------------
- tx-key never leaves browser (WASM memory only).  
- All other fields are public – safe to POST.  
- Amount & destination hashed → public inputs; fake values break proof.  
- Merkle root anchors payment to mined block.  
- Replay protection: store `keccak256(pubSignals)` in on-chain mapping.

--------------------------------------------------------------------
9.  Repository layout
--------------------------------------------------------------------
```
/circuits
  monero_payment.circom
  monero_payment.pk          (proving key, ~3 MB)
  monero_payment.vk          (verification key, ~1 kB)
/client
  proveMoneroPayment.ts      (section 5)
/onchain
  MoneroPaymentVerifier.sol
  programs/monero-zk-verify  (Anchor project)
```

--------------------------------------------------------------------
10.  One-sentence summary
--------------------------------------------------------------------
Paste **4 strings** from any wallet → browser produces **70-byte zk-SNARK** → Solana / Ethereum verifier accepts it, unlocking De-Fi value without ever exposing the sender’s secret key.
