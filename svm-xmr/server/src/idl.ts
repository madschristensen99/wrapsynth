// Generated IDL for stealth_swap program
export const IDL = {
  "version": "0.1.0",
  "name": "stealth_swap",
  "instructions": [
    {
      "name": "createUsdcToXmrSwap",
      "accounts": [
        { "name": "swap", "isMut": true, "isSigner": false },
        { "name": "alice", "isMut": true, "isSigner": true },
        { "name": "bob", "isMut": false, "isSigner": false },
        { "name": "aliceUsdc", "isMut": true, "isSigner": false },
        { "name": "vaultUsdc", "isMut": true, "isSigner": false },
        { "name": "usdcMint", "isMut": false, "isSigner": false },
        { "name": "tokenProgram", "isMut": false, "isSigner": false },
        { "name": "associatedTokenProgram", "isMut": false, "isSigner": false },
        { "name": "systemProgram", "isMut": false, "isSigner": false }
      ],
      "args": [
        { "name": "swapId", "type": { "array": ["u8", 32] } },
        { "name": "secretHash", "type": { "array": ["u8", 32] } },
        { "name": "usdcAmount", "type": "u64" },
        { "name": "xmrAmount", "type": "u64" },
        { "name": "moneroSubAddress", "type": { "array": ["u8", 64] } },
        { "name": "expiry", "type": "i64" },
        { "name": "relayerFee", "type": "u64" }
      ]
    },
    {
      "name": "createXmrToUsdcSwap",
      "accounts": [
        { "name": "swap", "isMut": true, "isSigner": false },
        { "name": "alice", "isMut": false, "isSigner": false },
        { "name": "bob", "isMut": true, "isSigner": true },
        { "name": "bobUsdc", "isMut": true, "isSigner": false },
        { "name": "vaultUsdc", "isMut": true, "isSigner": false },
        { "name": "usdcMint", "isMut": false, "isSigner": false },
        { "name": "tokenProgram", "isMut": false, "isSigner": false },
        { "name": "associatedTokenProgram", "isMut": false, "isSigner": false },
        { "name": "systemProgram", "isMut": false, "isSigner": false }
      ],
      "args": [
        { "name": "swapId", "type": { "array": ["u8", 32] } },
        { "name": "secretHash", "type": { "array": ["u8", 32] } },
        { "name": "usdcAmount", "type": "u64" },
        { "name": "xmrAmount", "type": "u64" },
        { "name": "aliceSolana", "type": "publicKey" },
        { "name": "expiry", "type": "i64" },
        { "name": "relayerFee", "type": "u64" }
      ]
    },
    {
      "name": "redeemUsdc",
      "accounts": [
        { "name": "swap", "isMut": true, "isSigner": false },
        { "name": "bob", "isMut": false, "isSigner": true },
        { "name": "vaultUsdc", "isMut": true, "isSigner": false },
        { "name": "bobToken", "isMut": true, "isSigner": false },
        { "name": "relayerToken", "isMut": true, "isSigner": false },
        { "name": "relayer", "isMut": false, "isSigner": false },
        { "name": "usdcMint", "isMut": false, "isSigner": false },
        { "name": "tokenProgram", "isMut": false, "isSigner": false },
        { "name": "associatedTokenProgram", "isMut": false, "isSigner": false },
        { "name": "systemProgram", "isMut": false, "isSigner": false }
      ],
      "args": [
        { "name": "swapId", "type": { "array": ["u8", 32] } },
        { "name": "adaptorSig", "type": "bytes" }
      ]
    }
  ],
  "accounts": [
    {
      "name": "Swap",
      "type": {
        "kind": "struct",
        "fields": [
          { "name": "direction", "type": { "defined": "Direction" } },
          { "name": "swapId", "type": { "array": ["u8", 32] } },
          { "name": "alice", "type": "publicKey" },
          { "name": "bob", "type": "publicKey" },
          { "name": "secretHash", "type": { "array": ["u8", 32] } },
          { "name": "expiry", "type": "i64" },
          { "name": "relayerFee", "type": "u64" },
          { "name": "isRedeemed", "type": "bool" },
          { "name": "isRefunded", "type": "bool" },
          { "name": "usdcAmount", "type": "u64" },
          { "name": "xmrAmount", "type": "u64" },
          { "name": "moneroSubAddress", "type": { "array": ["u8", 64] } },
          { "name": "moneroLockTxid", "type": { "array": ["u8", 32] } },
          { "name": "aliceSolana", "type": "publicKey" },
          { "name": "bump", "type": "u8" }
        ]
      }
    }
  ],
  "types": [
    {
      "name": "Direction",
      "type": {
        "kind": "enum",
        "variants": [
          { "name": "UsdcToXmr" },
          { "name": "XmrToUsdc" }
        ]
      }
    }
  ]
};