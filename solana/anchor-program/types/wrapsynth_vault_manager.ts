/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/wrapsynth_vault_manager.json`.
 */
export type WrapsynthVaultManager = {
  "address": "k4TC3sLs4feJfuMYBf8piyRQMU1WENM2LbQoKJNWbmx",
  "metadata": {
    "name": "wrapsynthVaultManager",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "WrapSynth Vault Manager - Solana port of VaultManager.sol"
  },
  "instructions": [
    {
      "name": "abandonKeyProvidedMint",
      "discriminator": [
        126,
        73,
        203,
        249,
        82,
        23,
        51,
        97
      ],
      "accounts": [
        {
          "name": "lp",
          "signer": true
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "lp"
              }
            ]
          }
        },
        {
          "name": "globalState",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  108,
                  111,
                  98,
                  97,
                  108,
                  95,
                  115,
                  116,
                  97,
                  116,
                  101
                ]
              }
            ]
          }
        },
        {
          "name": "mintRequest",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  105,
                  110,
                  116,
                  95,
                  114,
                  101,
                  113,
                  117,
                  101,
                  115,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "mint_request.request_id",
                "account": "mintRequest"
              }
            ]
          }
        },
        {
          "name": "lpReturns",
          "docs": [
            "Pre-existing PendingReturns for vault LP."
          ],
          "writable": true
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "lpSecret",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        }
      ]
    },
    {
      "name": "abandonProposedBurn",
      "discriminator": [
        126,
        241,
        188,
        48,
        240,
        98,
        145,
        149
      ],
      "accounts": [
        {
          "name": "lp",
          "signer": true
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "lp"
              }
            ]
          }
        },
        {
          "name": "globalState",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  108,
                  111,
                  98,
                  97,
                  108,
                  95,
                  115,
                  116,
                  97,
                  116,
                  101
                ]
              }
            ]
          }
        },
        {
          "name": "burnRequest",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  117,
                  114,
                  110,
                  95,
                  114,
                  101,
                  113,
                  117,
                  101,
                  115,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "burn_request.request_id",
                "account": "burnRequest"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "abortBurn",
      "discriminator": [
        42,
        251,
        42,
        181,
        42,
        89,
        207,
        8
      ],
      "accounts": [
        {
          "name": "caller",
          "writable": true,
          "signer": true
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "burn_request.lp_vault",
                "account": "burnRequest"
              }
            ]
          }
        },
        {
          "name": "globalState",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  108,
                  111,
                  98,
                  97,
                  108,
                  95,
                  115,
                  116,
                  97,
                  116,
                  101
                ]
              }
            ]
          }
        },
        {
          "name": "burnRequest",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  117,
                  114,
                  110,
                  95,
                  114,
                  101,
                  113,
                  117,
                  101,
                  115,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "burn_request.request_id",
                "account": "burnRequest"
              }
            ]
          }
        },
        {
          "name": "wsxmrMint",
          "writable": true
        },
        {
          "name": "userWsxmrAta",
          "writable": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "backstopVault",
      "docs": [
        "P1-1: A new LP assumes the debt and collateral of an underwater vault."
      ],
      "discriminator": [
        24,
        140,
        147,
        86,
        8,
        128,
        184,
        75
      ],
      "accounts": [
        {
          "name": "newLp",
          "writable": true,
          "signer": true
        },
        {
          "name": "oldVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "old_vault.lp_address",
                "account": "vault"
              }
            ]
          }
        },
        {
          "name": "newVault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "newLp"
              }
            ]
          }
        },
        {
          "name": "globalState",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  108,
                  111,
                  98,
                  97,
                  108,
                  95,
                  115,
                  116,
                  97,
                  116,
                  101
                ]
              }
            ]
          }
        },
        {
          "name": "pythXmr"
        },
        {
          "name": "pythCollateral"
        },
        {
          "name": "collateralMint"
        },
        {
          "name": "oldVaultCollateralAta",
          "docs": [
            "Old vault's collateral ATA — source of the absorbed balance."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116,
                  95,
                  99,
                  111,
                  108,
                  108,
                  97,
                  116,
                  101,
                  114,
                  97,
                  108
                ]
              },
              {
                "kind": "account",
                "path": "oldVault"
              }
            ]
          }
        },
        {
          "name": "newVaultCollateralAta",
          "docs": [
            "New vault's collateral ATA — destination of the absorbed balance."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116,
                  95,
                  99,
                  111,
                  108,
                  108,
                  97,
                  116,
                  101,
                  114,
                  97,
                  108
                ]
              },
              {
                "kind": "account",
                "path": "newVault"
              }
            ]
          }
        },
        {
          "name": "tokenProgram",
          "address": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "batchSetMinterWhitelist",
      "discriminator": [
        63,
        118,
        158,
        211,
        114,
        216,
        51,
        108
      ],
      "accounts": [
        {
          "name": "lp",
          "signer": true
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "lp"
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "minters",
          "type": {
            "vec": "pubkey"
          }
        },
        {
          "name": "whitelisted",
          "type": "bool"
        }
      ]
    },
    {
      "name": "cancelMint",
      "discriminator": [
        61,
        87,
        130,
        22,
        64,
        57,
        137,
        57
      ],
      "accounts": [
        {
          "name": "caller",
          "writable": true,
          "signer": true
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "vault.lp_address",
                "account": "vault"
              }
            ]
          }
        },
        {
          "name": "globalState",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  108,
                  111,
                  98,
                  97,
                  108,
                  95,
                  115,
                  116,
                  97,
                  116,
                  101
                ]
              }
            ]
          }
        },
        {
          "name": "mintRequest",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  105,
                  110,
                  116,
                  95,
                  114,
                  101,
                  113,
                  117,
                  101,
                  115,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "mint_request.request_id",
                "account": "mintRequest"
              }
            ]
          }
        },
        {
          "name": "initiatorReturns",
          "docs": [
            "Pre-existing PendingReturns for mint initiator (SOL refund + collateral slash)."
          ],
          "writable": true
        },
        {
          "name": "lpReturns",
          "docs": [
            "Pre-existing PendingReturns for vault LP."
          ],
          "writable": true
        },
        {
          "name": "wsxmrMint",
          "writable": true
        },
        {
          "name": "recipientWsxmrAta",
          "writable": true
        },
        {
          "name": "lpWsxmrAta",
          "writable": true
        },
        {
          "name": "collateralMint"
        },
        {
          "name": "vaultCollateralAta",
          "docs": [
            "Vault collateral ATA — slash source for the liquidated-vault branch."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116,
                  95,
                  99,
                  111,
                  108,
                  108,
                  97,
                  116,
                  101,
                  114,
                  97,
                  108
                ]
              },
              {
                "kind": "account",
                "path": "vault"
              }
            ]
          }
        },
        {
          "name": "programCollateralAta",
          "docs": [
            "Program collateral pool ATA — slash destination."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  103,
                  114,
                  97,
                  109,
                  95,
                  99,
                  111,
                  108,
                  108,
                  97,
                  116,
                  101,
                  114,
                  97,
                  108
                ]
              }
            ]
          }
        },
        {
          "name": "tokenProgram",
          "address": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "claimGriefingDeposit",
      "discriminator": [
        217,
        250,
        223,
        96,
        239,
        197,
        165,
        147
      ],
      "accounts": [
        {
          "name": "lp",
          "signer": true
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "lp"
              }
            ]
          }
        },
        {
          "name": "globalState",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  108,
                  111,
                  98,
                  97,
                  108,
                  95,
                  115,
                  116,
                  97,
                  116,
                  101
                ]
              }
            ]
          }
        },
        {
          "name": "mintRequest",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  105,
                  110,
                  116,
                  95,
                  114,
                  101,
                  113,
                  117,
                  101,
                  115,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "mint_request.request_id",
                "account": "mintRequest"
              }
            ]
          }
        },
        {
          "name": "lpReturns",
          "docs": [
            "Pre-existing PendingReturns for vault LP."
          ],
          "writable": true
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "lpSecret",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        }
      ]
    },
    {
      "name": "claimSlashedCollateral",
      "discriminator": [
        201,
        11,
        233,
        168,
        153,
        45,
        88,
        181
      ],
      "accounts": [
        {
          "name": "user",
          "writable": true,
          "signer": true
        },
        {
          "name": "vaultLp"
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "vaultLp"
              }
            ]
          }
        },
        {
          "name": "globalState",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  108,
                  111,
                  98,
                  97,
                  108,
                  95,
                  115,
                  116,
                  97,
                  116,
                  101
                ]
              }
            ]
          }
        },
        {
          "name": "burnRequest",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  117,
                  114,
                  110,
                  95,
                  114,
                  101,
                  113,
                  117,
                  101,
                  115,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "burn_request.request_id",
                "account": "burnRequest"
              }
            ]
          }
        },
        {
          "name": "userPendingReturns",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  101,
                  110,
                  100,
                  105,
                  110,
                  103,
                  95,
                  114,
                  101,
                  116,
                  117,
                  114,
                  110,
                  115
                ]
              },
              {
                "kind": "account",
                "path": "user"
              }
            ]
          }
        },
        {
          "name": "pythXmr"
        },
        {
          "name": "pythCollateral"
        },
        {
          "name": "collateralMint"
        },
        {
          "name": "vaultCollateralAta",
          "docs": [
            "Vault collateral ATA — slash source for the par-capped payout."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116,
                  95,
                  99,
                  111,
                  108,
                  108,
                  97,
                  116,
                  101,
                  114,
                  97,
                  108
                ]
              },
              {
                "kind": "account",
                "path": "vault"
              }
            ]
          }
        },
        {
          "name": "programCollateralAta",
          "docs": [
            "Program collateral pool ATA — slash destination."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  103,
                  114,
                  97,
                  109,
                  95,
                  99,
                  111,
                  108,
                  108,
                  97,
                  116,
                  101,
                  114,
                  97,
                  108
                ]
              }
            ]
          }
        },
        {
          "name": "tokenProgram",
          "address": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "userSecret",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        }
      ]
    },
    {
      "name": "collectCoLpFees",
      "docs": [
        "LP or user collects accrued fees from a co-LP position."
      ],
      "discriminator": [
        108,
        252,
        128,
        173,
        124,
        40,
        16,
        33
      ],
      "accounts": [
        {
          "name": "caller",
          "writable": true,
          "signer": true
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "vault.lp_address",
                "account": "vault"
              }
            ]
          }
        },
        {
          "name": "globalState",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  108,
                  111,
                  98,
                  97,
                  108,
                  95,
                  115,
                  116,
                  97,
                  116,
                  101
                ]
              }
            ]
          }
        },
        {
          "name": "coLpPosition",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  95,
                  108,
                  112,
                  95,
                  112,
                  111,
                  115,
                  105,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "co_lp_position.vault",
                "account": "coLpPosition"
              },
              {
                "kind": "account",
                "path": "co_lp_position.user",
                "account": "coLpPosition"
              },
              {
                "kind": "account",
                "path": "co_lp_position.nonce",
                "account": "coLpPosition"
              }
            ]
          }
        },
        {
          "name": "position",
          "docs": [
            "Orca Position account"
          ],
          "writable": true
        },
        {
          "name": "whirlpool",
          "docs": [
            "Orca Whirlpool account"
          ],
          "writable": true
        },
        {
          "name": "positionTokenAccount",
          "writable": true
        },
        {
          "name": "positionCollateralAta",
          "writable": true
        },
        {
          "name": "positionWsxmrAta",
          "writable": true
        },
        {
          "name": "vaultCollateralAta",
          "writable": true
        },
        {
          "name": "userWsxmrAta",
          "writable": true
        },
        {
          "name": "collateralMint"
        },
        {
          "name": "wsxmrMint"
        },
        {
          "name": "tokenProgram",
          "address": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "confirmMoneroLock",
      "discriminator": [
        39,
        152,
        65,
        15,
        181,
        0,
        117,
        242
      ],
      "accounts": [
        {
          "name": "user",
          "signer": true
        },
        {
          "name": "burnRequest",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  117,
                  114,
                  110,
                  95,
                  114,
                  101,
                  113,
                  117,
                  101,
                  115,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "burn_request.request_id",
                "account": "burnRequest"
              }
            ]
          }
        }
      ],
      "args": []
    },
    {
      "name": "createVault",
      "discriminator": [
        29,
        237,
        247,
        208,
        193,
        82,
        54,
        135
      ],
      "accounts": [
        {
          "name": "lp",
          "writable": true,
          "signer": true
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "lp"
              }
            ]
          }
        },
        {
          "name": "globalState",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  108,
                  111,
                  98,
                  97,
                  108,
                  95,
                  115,
                  116,
                  97,
                  116,
                  101
                ]
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "deactivateVault",
      "discriminator": [
        152,
        132,
        22,
        236,
        200,
        128,
        124,
        174
      ],
      "accounts": [
        {
          "name": "lp",
          "writable": true,
          "signer": true
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "lp"
              }
            ]
          }
        },
        {
          "name": "globalState",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  108,
                  111,
                  98,
                  97,
                  108,
                  95,
                  115,
                  116,
                  97,
                  116,
                  101
                ]
              }
            ]
          }
        }
      ],
      "args": []
    },
    {
      "name": "depositCollateral",
      "discriminator": [
        156,
        131,
        142,
        116,
        146,
        247,
        162,
        120
      ],
      "accounts": [
        {
          "name": "lp",
          "writable": true,
          "signer": true
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "lp"
              }
            ]
          }
        },
        {
          "name": "globalState",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  108,
                  111,
                  98,
                  97,
                  108,
                  95,
                  115,
                  116,
                  97,
                  116,
                  101
                ]
              }
            ]
          }
        },
        {
          "name": "collateralMint"
        },
        {
          "name": "lpCollateralAta",
          "writable": true
        },
        {
          "name": "vaultCollateralAta",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116,
                  95,
                  99,
                  111,
                  108,
                  108,
                  97,
                  116,
                  101,
                  114,
                  97,
                  108
                ]
              },
              {
                "kind": "account",
                "path": "vault"
              }
            ]
          }
        },
        {
          "name": "tokenProgram",
          "address": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "amount",
          "type": "u64"
        }
      ]
    },
    {
      "name": "executeLiquidation",
      "docs": [
        "Phase 2: execute the actual liquidation after all burns are resolved."
      ],
      "discriminator": [
        189,
        55,
        38,
        121,
        165,
        84,
        96,
        124
      ],
      "accounts": [
        {
          "name": "liquidator",
          "writable": true,
          "signer": true
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "vault.lp_address",
                "account": "vault"
              }
            ]
          }
        },
        {
          "name": "globalState",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  108,
                  111,
                  98,
                  97,
                  108,
                  95,
                  115,
                  116,
                  97,
                  116,
                  101
                ]
              }
            ]
          }
        },
        {
          "name": "wsxmrMint",
          "writable": true
        },
        {
          "name": "collateralMint"
        },
        {
          "name": "liquidatorWsxmrAta",
          "writable": true
        },
        {
          "name": "liquidatorCollateralAta",
          "writable": true
        },
        {
          "name": "vaultCollateralAta",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116,
                  95,
                  99,
                  111,
                  108,
                  108,
                  97,
                  116,
                  101,
                  114,
                  97,
                  108
                ]
              },
              {
                "kind": "account",
                "path": "vault"
              }
            ]
          }
        },
        {
          "name": "pythXmr"
        },
        {
          "name": "pythCollateral"
        },
        {
          "name": "tokenProgram",
          "address": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "debtToClear",
          "type": "u64"
        }
      ]
    },
    {
      "name": "finalizeBurn",
      "discriminator": [
        214,
        238,
        193,
        136,
        253,
        151,
        249,
        13
      ],
      "accounts": [
        {
          "name": "caller",
          "writable": true,
          "signer": true
        },
        {
          "name": "vaultLp"
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "vaultLp"
              }
            ]
          }
        },
        {
          "name": "globalState",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  108,
                  111,
                  98,
                  97,
                  108,
                  95,
                  115,
                  116,
                  97,
                  116,
                  101
                ]
              }
            ]
          }
        },
        {
          "name": "burnRequest",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  117,
                  114,
                  110,
                  95,
                  114,
                  101,
                  113,
                  117,
                  101,
                  115,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "burn_request.request_id",
                "account": "burnRequest"
              }
            ]
          }
        },
        {
          "name": "userPendingReturns",
          "docs": [
            "Pre-existing PendingReturns for burn user. Created via initialize_pending_returns."
          ],
          "writable": true
        },
        {
          "name": "pythXmr"
        },
        {
          "name": "pythCollateral"
        },
        {
          "name": "collateralMint"
        },
        {
          "name": "vaultCollateralAta",
          "docs": [
            "Vault collateral ATA — slash source for the user reward."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116,
                  95,
                  99,
                  111,
                  108,
                  108,
                  97,
                  116,
                  101,
                  114,
                  97,
                  108
                ]
              },
              {
                "kind": "account",
                "path": "vault"
              }
            ]
          }
        },
        {
          "name": "programCollateralAta",
          "docs": [
            "Program collateral pool ATA — slash destination."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  103,
                  114,
                  97,
                  109,
                  95,
                  99,
                  111,
                  108,
                  108,
                  97,
                  116,
                  101,
                  114,
                  97,
                  108
                ]
              }
            ]
          }
        },
        {
          "name": "tokenProgram",
          "address": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "secret",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        }
      ]
    },
    {
      "name": "finalizeMint",
      "discriminator": [
        77,
        12,
        218,
        47,
        57,
        4,
        38,
        239
      ],
      "accounts": [
        {
          "name": "caller",
          "writable": true,
          "signer": true
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "vault.lp_address",
                "account": "vault"
              }
            ]
          }
        },
        {
          "name": "globalState",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  108,
                  111,
                  98,
                  97,
                  108,
                  95,
                  115,
                  116,
                  97,
                  116,
                  101
                ]
              }
            ]
          }
        },
        {
          "name": "mintRequest",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  105,
                  110,
                  116,
                  95,
                  114,
                  101,
                  113,
                  117,
                  101,
                  115,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "mint_request.request_id",
                "account": "mintRequest"
              }
            ]
          }
        },
        {
          "name": "wsxmrMint",
          "writable": true
        },
        {
          "name": "recipientWsxmrAta",
          "writable": true
        },
        {
          "name": "lpWsxmrAta",
          "writable": true
        },
        {
          "name": "pendingReturns",
          "docs": [
            "Pre-existing PendingReturns for mint initiator. Created via initialize_pending_returns."
          ],
          "writable": true
        },
        {
          "name": "collateralMint"
        },
        {
          "name": "vaultCollateralAta",
          "docs": [
            "Vault collateral ATA — slash source for the liquidated-vault branch."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116,
                  95,
                  99,
                  111,
                  108,
                  108,
                  97,
                  116,
                  101,
                  114,
                  97,
                  108
                ]
              },
              {
                "kind": "account",
                "path": "vault"
              }
            ]
          }
        },
        {
          "name": "programCollateralAta",
          "docs": [
            "Program collateral pool ATA — slash destination."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  103,
                  114,
                  97,
                  109,
                  95,
                  99,
                  111,
                  108,
                  108,
                  97,
                  116,
                  101,
                  114,
                  97,
                  108
                ]
              }
            ]
          }
        },
        {
          "name": "tokenProgram",
          "address": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "forceSettleBurn",
      "discriminator": [
        164,
        19,
        246,
        100,
        252,
        209,
        204,
        65
      ],
      "accounts": [
        {
          "name": "caller",
          "writable": true,
          "signer": true
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "burn_request.lp_vault",
                "account": "burnRequest"
              }
            ]
          }
        },
        {
          "name": "globalState",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  108,
                  111,
                  98,
                  97,
                  108,
                  95,
                  115,
                  116,
                  97,
                  116,
                  101
                ]
              }
            ]
          }
        },
        {
          "name": "burnRequest",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  117,
                  114,
                  110,
                  95,
                  114,
                  101,
                  113,
                  117,
                  101,
                  115,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "burn_request.request_id",
                "account": "burnRequest"
              }
            ]
          }
        },
        {
          "name": "userPendingReturns",
          "docs": [
            "Pre-existing PendingReturns for burn user."
          ],
          "writable": true
        },
        {
          "name": "pythXmr"
        },
        {
          "name": "pythCollateral"
        },
        {
          "name": "collateralMint"
        },
        {
          "name": "vaultCollateralAta",
          "docs": [
            "Vault collateral ATA — slash source for the par-capped payout."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116,
                  95,
                  99,
                  111,
                  108,
                  108,
                  97,
                  116,
                  101,
                  114,
                  97,
                  108
                ]
              },
              {
                "kind": "account",
                "path": "vault"
              }
            ]
          }
        },
        {
          "name": "programCollateralAta",
          "docs": [
            "Program collateral pool ATA — slash destination."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  103,
                  114,
                  97,
                  109,
                  95,
                  99,
                  111,
                  108,
                  108,
                  97,
                  116,
                  101,
                  114,
                  97,
                  108
                ]
              }
            ]
          }
        },
        {
          "name": "tokenProgram",
          "address": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "initialize",
      "discriminator": [
        175,
        175,
        109,
        31,
        13,
        152,
        155,
        237
      ],
      "accounts": [
        {
          "name": "authority",
          "writable": true,
          "signer": true
        },
        {
          "name": "globalState",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  108,
                  111,
                  98,
                  97,
                  108,
                  95,
                  115,
                  116,
                  97,
                  116,
                  101
                ]
              }
            ]
          }
        },
        {
          "name": "wsxmrMint",
          "docs": [
            "wsXMR Token-2022 mint PDA. Allocated and initialized manually in handler",
            "to avoid Anchor 0.30 double-init bug with InterfaceAccount<Mint> + Token-2022."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  119,
                  115,
                  120,
                  109,
                  114,
                  95,
                  109,
                  105,
                  110,
                  116
                ]
              }
            ]
          }
        },
        {
          "name": "collateralMint",
          "docs": [
            "Program collateral ATA — the pending-returns pool backing all slashed",
            "collateral credits. The mint is supplied via argument so initialize is",
            "collateral-agnostic."
          ]
        },
        {
          "name": "programCollateralAta",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  103,
                  114,
                  97,
                  109,
                  95,
                  99,
                  111,
                  108,
                  108,
                  97,
                  116,
                  101,
                  114,
                  97,
                  108
                ]
              }
            ]
          }
        },
        {
          "name": "tokenProgram",
          "address": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "rent",
          "address": "SysvarRent111111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "pythXmrFeed",
          "type": "pubkey"
        },
        {
          "name": "collateralMint",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "initializePendingReturns",
      "discriminator": [
        77,
        175,
        235,
        181,
        231,
        87,
        166,
        117
      ],
      "accounts": [
        {
          "name": "owner",
          "writable": true,
          "signer": true
        },
        {
          "name": "pendingReturns",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  101,
                  110,
                  100,
                  105,
                  110,
                  103,
                  95,
                  114,
                  101,
                  116,
                  117,
                  114,
                  110,
                  115
                ]
              },
              {
                "kind": "account",
                "path": "owner"
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "initializeVaultCollateral",
      "discriminator": [
        64,
        160,
        30,
        204,
        90,
        27,
        120,
        130
      ],
      "accounts": [
        {
          "name": "lp",
          "writable": true,
          "signer": true
        },
        {
          "name": "vault",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "lp"
              }
            ]
          }
        },
        {
          "name": "collateralMint"
        },
        {
          "name": "vaultCollateralAta",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116,
                  95,
                  99,
                  111,
                  108,
                  108,
                  97,
                  116,
                  101,
                  114,
                  97,
                  108
                ]
              },
              {
                "kind": "account",
                "path": "vault"
              }
            ]
          }
        },
        {
          "name": "tokenProgram",
          "address": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "initiateMint",
      "discriminator": [
        198,
        6,
        136,
        107,
        232,
        232,
        179,
        158
      ],
      "accounts": [
        {
          "name": "initiator",
          "writable": true,
          "signer": true
        },
        {
          "name": "recipient"
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "vault.lp_address",
                "account": "vault"
              }
            ]
          }
        },
        {
          "name": "globalState",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  108,
                  111,
                  98,
                  97,
                  108,
                  95,
                  115,
                  116,
                  97,
                  116,
                  101
                ]
              }
            ]
          }
        },
        {
          "name": "mintRequest",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  105,
                  110,
                  116,
                  95,
                  114,
                  101,
                  113,
                  117,
                  101,
                  115,
                  116
                ]
              },
              {
                "kind": "arg",
                "path": "requestId"
              }
            ]
          }
        },
        {
          "name": "griefingEscrow",
          "docs": [
            "SOL escrow account for griefing deposit (created by initiator, lamports checked)"
          ],
          "writable": true
        },
        {
          "name": "initiatorPendingReturns",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  101,
                  110,
                  100,
                  105,
                  110,
                  103,
                  95,
                  114,
                  101,
                  116,
                  117,
                  114,
                  110,
                  115
                ]
              },
              {
                "kind": "account",
                "path": "initiator"
              }
            ]
          }
        },
        {
          "name": "pythXmr"
        },
        {
          "name": "pythCollateral"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "xmrAmount",
          "type": "u64"
        },
        {
          "name": "claimCommitment",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "userPublicKey",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "requestId",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        }
      ]
    },
    {
      "name": "proposeHash",
      "discriminator": [
        45,
        6,
        224,
        60,
        98,
        64,
        142,
        49
      ],
      "accounts": [
        {
          "name": "lp",
          "signer": true
        },
        {
          "name": "vault",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "lp"
              }
            ]
          }
        },
        {
          "name": "burnRequest",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  117,
                  114,
                  110,
                  95,
                  114,
                  101,
                  113,
                  117,
                  101,
                  115,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "burn_request.request_id",
                "account": "burnRequest"
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "secretHash",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "lpPublicSpendKey",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "lpPublicViewKey",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        }
      ]
    },
    {
      "name": "provideLpKey",
      "discriminator": [
        160,
        213,
        144,
        181,
        224,
        59,
        53,
        148
      ],
      "accounts": [
        {
          "name": "lp",
          "signer": true
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "lp"
              }
            ]
          }
        },
        {
          "name": "globalState",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  108,
                  111,
                  98,
                  97,
                  108,
                  95,
                  115,
                  116,
                  97,
                  116,
                  101
                ]
              }
            ]
          }
        },
        {
          "name": "mintRequest",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  105,
                  110,
                  116,
                  95,
                  114,
                  101,
                  113,
                  117,
                  101,
                  115,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "mint_request.request_id",
                "account": "mintRequest"
              }
            ]
          }
        },
        {
          "name": "pythXmr"
        },
        {
          "name": "pythCollateral"
        }
      ],
      "args": [
        {
          "name": "lpPublicSpendKey",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "lpPublicViewKey",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "lpCommitment",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        }
      ]
    },
    {
      "name": "rebalanceCoLp",
      "docs": [
        "Keeper drains a co-LP position for rebalancing (re-open via user_open_co_lp)."
      ],
      "discriminator": [
        54,
        103,
        200,
        77,
        47,
        2,
        60,
        204
      ],
      "accounts": [
        {
          "name": "caller",
          "writable": true,
          "signer": true
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "vault.lp_address",
                "account": "vault"
              }
            ]
          }
        },
        {
          "name": "globalState",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  108,
                  111,
                  98,
                  97,
                  108,
                  95,
                  115,
                  116,
                  97,
                  116,
                  101
                ]
              }
            ]
          }
        },
        {
          "name": "coLpPosition",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  95,
                  108,
                  112,
                  95,
                  112,
                  111,
                  115,
                  105,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "co_lp_position.vault",
                "account": "coLpPosition"
              },
              {
                "kind": "account",
                "path": "co_lp_position.user",
                "account": "coLpPosition"
              },
              {
                "kind": "account",
                "path": "co_lp_position.nonce",
                "account": "coLpPosition"
              }
            ]
          }
        },
        {
          "name": "position",
          "docs": [
            "Orca Position account"
          ],
          "writable": true
        },
        {
          "name": "whirlpool",
          "docs": [
            "Orca Whirlpool account"
          ],
          "writable": true
        },
        {
          "name": "positionTokenAccount",
          "writable": true
        },
        {
          "name": "tickArrayLower",
          "writable": true
        },
        {
          "name": "tickArrayUpper",
          "writable": true
        },
        {
          "name": "positionCollateralAta",
          "writable": true
        },
        {
          "name": "positionWsxmrAta",
          "writable": true
        },
        {
          "name": "vaultCollateralAta",
          "writable": true
        },
        {
          "name": "userWsxmrAta",
          "writable": true
        },
        {
          "name": "collateralMint"
        },
        {
          "name": "wsxmrMint"
        },
        {
          "name": "tokenProgram",
          "address": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "newRangeBps",
          "type": "u16"
        }
      ]
    },
    {
      "name": "reclaimParkedDeposit",
      "discriminator": [
        125,
        53,
        47,
        58,
        183,
        17,
        36,
        165
      ],
      "accounts": [
        {
          "name": "caller",
          "writable": true,
          "signer": true
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "vault.lp_address",
                "account": "vault"
              }
            ]
          }
        },
        {
          "name": "globalState",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  108,
                  111,
                  98,
                  97,
                  108,
                  95,
                  115,
                  116,
                  97,
                  116,
                  101
                ]
              }
            ]
          }
        },
        {
          "name": "mintRequest",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  105,
                  110,
                  116,
                  95,
                  114,
                  101,
                  113,
                  117,
                  101,
                  115,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "mint_request.request_id",
                "account": "mintRequest"
              }
            ]
          }
        },
        {
          "name": "initiatorReturns",
          "docs": [
            "Pre-existing PendingReturns for mint initiator (collateral slash + SOL refund)."
          ],
          "writable": true
        },
        {
          "name": "collateralMint"
        },
        {
          "name": "vaultCollateralAta",
          "docs": [
            "Vault collateral ATA — slash source."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116,
                  95,
                  99,
                  111,
                  108,
                  108,
                  97,
                  116,
                  101,
                  114,
                  97,
                  108
                ]
              },
              {
                "kind": "account",
                "path": "vault"
              }
            ]
          }
        },
        {
          "name": "programCollateralAta",
          "docs": [
            "Program collateral pool ATA — slash destination."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  103,
                  114,
                  97,
                  109,
                  95,
                  99,
                  111,
                  108,
                  108,
                  97,
                  116,
                  101,
                  114,
                  97,
                  108
                ]
              }
            ]
          }
        },
        {
          "name": "tokenProgram",
          "address": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "reconcileGlobalDebt",
      "discriminator": [
        217,
        34,
        41,
        18,
        221,
        74,
        151,
        218
      ],
      "accounts": [
        {
          "name": "authority",
          "signer": true
        },
        {
          "name": "globalState",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  108,
                  111,
                  98,
                  97,
                  108,
                  95,
                  115,
                  116,
                  97,
                  116,
                  101
                ]
              }
            ]
          }
        }
      ],
      "args": []
    },
    {
      "name": "requestBurn",
      "discriminator": [
        222,
        82,
        224,
        225,
        201,
        96,
        24,
        213
      ],
      "accounts": [
        {
          "name": "user",
          "writable": true,
          "signer": true
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "vault.lp_address",
                "account": "vault"
              }
            ]
          }
        },
        {
          "name": "globalState",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  108,
                  111,
                  98,
                  97,
                  108,
                  95,
                  115,
                  116,
                  97,
                  116,
                  101
                ]
              }
            ]
          }
        },
        {
          "name": "burnRequest",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  117,
                  114,
                  110,
                  95,
                  114,
                  101,
                  113,
                  117,
                  101,
                  115,
                  116
                ]
              },
              {
                "kind": "arg",
                "path": "requestId"
              }
            ]
          }
        },
        {
          "name": "wsxmrMint",
          "writable": true
        },
        {
          "name": "userWsxmrAta",
          "writable": true
        },
        {
          "name": "pythXmr"
        },
        {
          "name": "pythCollateral"
        },
        {
          "name": "tokenProgram",
          "address": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "wsxmrAmount",
          "type": "u64"
        },
        {
          "name": "claimCommitment",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "userPublicKey",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "userViewKey",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "requestId",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        }
      ]
    },
    {
      "name": "requestBurnFromRouter",
      "discriminator": [
        165,
        189,
        125,
        181,
        77,
        206,
        115,
        69
      ],
      "accounts": [
        {
          "name": "user",
          "writable": true,
          "signer": true
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "vault.lp_address",
                "account": "vault"
              }
            ]
          }
        },
        {
          "name": "globalState",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  108,
                  111,
                  98,
                  97,
                  108,
                  95,
                  115,
                  116,
                  97,
                  116,
                  101
                ]
              }
            ]
          }
        },
        {
          "name": "burnRequest",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  117,
                  114,
                  110,
                  95,
                  114,
                  101,
                  113,
                  117,
                  101,
                  115,
                  116
                ]
              },
              {
                "kind": "arg",
                "path": "requestId"
              }
            ]
          }
        },
        {
          "name": "wsxmrMint",
          "writable": true
        },
        {
          "name": "userWsxmrAta",
          "writable": true
        },
        {
          "name": "pythXmr"
        },
        {
          "name": "pythCollateral"
        },
        {
          "name": "tokenProgram",
          "address": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "wsxmrAmount",
          "type": "u64"
        },
        {
          "name": "claimCommitment",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "userPublicKey",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "userViewKey",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        },
        {
          "name": "requestId",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        }
      ]
    },
    {
      "name": "resolveBurnForLiquidation",
      "docs": [
        "Phase 1: resolve a single active burn on a liquidatable vault.",
        "Call once per active burn. Permissionless."
      ],
      "discriminator": [
        19,
        207,
        91,
        53,
        234,
        124,
        111,
        87
      ],
      "accounts": [
        {
          "name": "caller",
          "writable": true,
          "signer": true
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "vault.lp_address",
                "account": "vault"
              }
            ]
          }
        },
        {
          "name": "globalState",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  108,
                  111,
                  98,
                  97,
                  108,
                  95,
                  115,
                  116,
                  97,
                  116,
                  101
                ]
              }
            ]
          }
        },
        {
          "name": "burnRequest",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  117,
                  114,
                  110,
                  95,
                  114,
                  101,
                  113,
                  117,
                  101,
                  115,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "burn_request.request_id",
                "account": "burnRequest"
              }
            ]
          }
        },
        {
          "name": "userPendingReturns",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  101,
                  110,
                  100,
                  105,
                  110,
                  103,
                  95,
                  114,
                  101,
                  116,
                  117,
                  114,
                  110,
                  115
                ]
              },
              {
                "kind": "account",
                "path": "burn_request.user",
                "account": "burnRequest"
              }
            ]
          }
        },
        {
          "name": "wsxmrMint",
          "writable": true
        },
        {
          "name": "userWsxmrAta",
          "writable": true
        },
        {
          "name": "pythXmr"
        },
        {
          "name": "pythCollateral"
        },
        {
          "name": "collateralMint"
        },
        {
          "name": "vaultCollateralAta",
          "docs": [
            "Vault collateral ATA — slash source for revealed/committed burn payouts."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116,
                  95,
                  99,
                  111,
                  108,
                  108,
                  97,
                  116,
                  101,
                  114,
                  97,
                  108
                ]
              },
              {
                "kind": "account",
                "path": "vault"
              }
            ]
          }
        },
        {
          "name": "programCollateralAta",
          "docs": [
            "Program collateral pool ATA — slash destination."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  103,
                  114,
                  97,
                  109,
                  95,
                  99,
                  111,
                  108,
                  108,
                  97,
                  116,
                  101,
                  114,
                  97,
                  108
                ]
              }
            ]
          }
        },
        {
          "name": "tokenProgram",
          "address": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "resolveDeclinedProposal",
      "discriminator": [
        22,
        90,
        112,
        173,
        227,
        128,
        118,
        7
      ],
      "accounts": [
        {
          "name": "caller",
          "writable": true,
          "signer": true
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "burn_request.lp_vault",
                "account": "burnRequest"
              }
            ]
          }
        },
        {
          "name": "globalState",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  108,
                  111,
                  98,
                  97,
                  108,
                  95,
                  115,
                  116,
                  97,
                  116,
                  101
                ]
              }
            ]
          }
        },
        {
          "name": "burnRequest",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  117,
                  114,
                  110,
                  95,
                  114,
                  101,
                  113,
                  117,
                  101,
                  115,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "burn_request.request_id",
                "account": "burnRequest"
              }
            ]
          }
        },
        {
          "name": "wsxmrMint",
          "writable": true
        },
        {
          "name": "userWsxmrAta",
          "writable": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "userSecret",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        }
      ]
    },
    {
      "name": "revealBurnSecret",
      "discriminator": [
        119,
        200,
        232,
        221,
        74,
        199,
        52,
        18
      ],
      "accounts": [
        {
          "name": "caller",
          "writable": true,
          "signer": true
        },
        {
          "name": "burnRequest",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  117,
                  114,
                  110,
                  95,
                  114,
                  101,
                  113,
                  117,
                  101,
                  115,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "burn_request.request_id",
                "account": "burnRequest"
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "secret",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        }
      ]
    },
    {
      "name": "revealSecret",
      "discriminator": [
        126,
        156,
        142,
        60,
        92,
        135,
        177,
        144
      ],
      "accounts": [
        {
          "name": "caller",
          "writable": true,
          "signer": true
        },
        {
          "name": "mintRequest",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  105,
                  110,
                  116,
                  95,
                  114,
                  101,
                  113,
                  117,
                  101,
                  115,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "mint_request.request_id",
                "account": "mintRequest"
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "secret",
          "type": {
            "array": [
              "u8",
              32
            ]
          }
        }
      ]
    },
    {
      "name": "setBurnTimeout",
      "discriminator": [
        147,
        112,
        29,
        38,
        104,
        223,
        169,
        84
      ],
      "accounts": [
        {
          "name": "lp",
          "signer": true
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "lp"
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "seconds",
          "type": "i64"
        }
      ]
    },
    {
      "name": "setLiquidityRouter",
      "discriminator": [
        4,
        57,
        195,
        0,
        242,
        41,
        192,
        236
      ],
      "accounts": [
        {
          "name": "authority",
          "signer": true
        },
        {
          "name": "globalState",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  108,
                  111,
                  98,
                  97,
                  108,
                  95,
                  115,
                  116,
                  97,
                  116,
                  101
                ]
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "router",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "setMaxCoLpRange",
      "docs": [
        "LP sets the preferred max co-LP range width (basis points)."
      ],
      "discriminator": [
        50,
        5,
        149,
        213,
        22,
        184,
        136,
        177
      ],
      "accounts": [
        {
          "name": "lp",
          "signer": true
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "lp"
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "bps",
          "type": "u16"
        }
      ]
    },
    {
      "name": "setMaxMintBps",
      "discriminator": [
        179,
        42,
        1,
        225,
        89,
        24,
        172,
        5
      ],
      "accounts": [
        {
          "name": "lp",
          "signer": true
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "lp"
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "maxMintBps",
          "type": "u16"
        }
      ]
    },
    {
      "name": "setMinBurnAmount",
      "discriminator": [
        88,
        59,
        48,
        178,
        80,
        23,
        100,
        218
      ],
      "accounts": [
        {
          "name": "lp",
          "signer": true
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "lp"
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "minAmount",
          "type": "u64"
        }
      ]
    },
    {
      "name": "setMintGriefingDeposit",
      "discriminator": [
        65,
        157,
        253,
        230,
        59,
        150,
        28,
        102
      ],
      "accounts": [
        {
          "name": "lp",
          "signer": true
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "lp"
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "deposit",
          "type": "u64"
        }
      ]
    },
    {
      "name": "setMintReady",
      "discriminator": [
        109,
        66,
        111,
        178,
        198,
        143,
        235,
        173
      ],
      "accounts": [
        {
          "name": "lp",
          "signer": true
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "lp"
              }
            ]
          }
        },
        {
          "name": "globalState",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  108,
                  111,
                  98,
                  97,
                  108,
                  95,
                  115,
                  116,
                  97,
                  116,
                  101
                ]
              }
            ]
          }
        },
        {
          "name": "mintRequest",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  105,
                  110,
                  116,
                  95,
                  114,
                  101,
                  113,
                  117,
                  101,
                  115,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "mint_request.request_id",
                "account": "mintRequest"
              }
            ]
          }
        },
        {
          "name": "pythXmr"
        },
        {
          "name": "pythCollateral"
        }
      ],
      "args": []
    },
    {
      "name": "setMintTimeout",
      "discriminator": [
        244,
        81,
        151,
        11,
        220,
        66,
        153,
        116
      ],
      "accounts": [
        {
          "name": "lp",
          "signer": true
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "lp"
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "seconds",
          "type": "i64"
        }
      ]
    },
    {
      "name": "setMinterWhitelist",
      "discriminator": [
        194,
        112,
        167,
        67,
        242,
        7,
        54,
        102
      ],
      "accounts": [
        {
          "name": "lp",
          "signer": true
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "lp"
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "minter",
          "type": "pubkey"
        },
        {
          "name": "whitelisted",
          "type": "bool"
        }
      ]
    },
    {
      "name": "setVaultMarketMetrics",
      "discriminator": [
        149,
        233,
        151,
        73,
        97,
        154,
        111,
        224
      ],
      "accounts": [
        {
          "name": "lp",
          "signer": true
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "lp"
              }
            ]
          }
        }
      ],
      "args": [
        {
          "name": "mintFeeBps",
          "type": "u16"
        },
        {
          "name": "burnRewardBps",
          "type": "u16"
        }
      ]
    },
    {
      "name": "settleBurn",
      "discriminator": [
        12,
        139,
        212,
        132,
        234,
        51,
        0,
        8
      ],
      "accounts": [
        {
          "name": "caller",
          "writable": true,
          "signer": true
        },
        {
          "name": "vaultLp"
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "vaultLp"
              }
            ]
          }
        },
        {
          "name": "globalState",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  108,
                  111,
                  98,
                  97,
                  108,
                  95,
                  115,
                  116,
                  97,
                  116,
                  101
                ]
              }
            ]
          }
        },
        {
          "name": "burnRequest",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  117,
                  114,
                  110,
                  95,
                  114,
                  101,
                  113,
                  117,
                  101,
                  115,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "burn_request.request_id",
                "account": "burnRequest"
              }
            ]
          }
        },
        {
          "name": "userPendingReturns",
          "docs": [
            "Pre-existing PendingReturns for burn user. Created via initialize_pending_returns."
          ],
          "writable": true
        },
        {
          "name": "pythXmr"
        },
        {
          "name": "pythCollateral"
        },
        {
          "name": "collateralMint"
        },
        {
          "name": "vaultCollateralAta",
          "docs": [
            "Vault collateral ATA — slash source for the user reward."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116,
                  95,
                  99,
                  111,
                  108,
                  108,
                  97,
                  116,
                  101,
                  114,
                  97,
                  108
                ]
              },
              {
                "kind": "account",
                "path": "vault"
              }
            ]
          }
        },
        {
          "name": "programCollateralAta",
          "docs": [
            "Program collateral pool ATA — slash destination."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  103,
                  114,
                  97,
                  109,
                  95,
                  99,
                  111,
                  108,
                  108,
                  97,
                  116,
                  101,
                  114,
                  97,
                  108
                ]
              }
            ]
          }
        },
        {
          "name": "tokenProgram",
          "address": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "sweepUnclaimedExpiredMint",
      "discriminator": [
        175,
        118,
        222,
        107,
        184,
        44,
        31,
        1
      ],
      "accounts": [
        {
          "name": "caller",
          "writable": true,
          "signer": true
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "vault.lp_address",
                "account": "vault"
              }
            ]
          }
        },
        {
          "name": "globalState",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  108,
                  111,
                  98,
                  97,
                  108,
                  95,
                  115,
                  116,
                  97,
                  116,
                  101
                ]
              }
            ]
          }
        },
        {
          "name": "mintRequest",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  109,
                  105,
                  110,
                  116,
                  95,
                  114,
                  101,
                  113,
                  117,
                  101,
                  115,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "mint_request.request_id",
                "account": "mintRequest"
              }
            ]
          }
        },
        {
          "name": "initiatorReturns",
          "docs": [
            "Pre-existing PendingReturns for mint initiator (collateral slash + SOL refund)."
          ],
          "writable": true
        },
        {
          "name": "collateralMint"
        },
        {
          "name": "vaultCollateralAta",
          "docs": [
            "Vault collateral ATA — slash source."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116,
                  95,
                  99,
                  111,
                  108,
                  108,
                  97,
                  116,
                  101,
                  114,
                  97,
                  108
                ]
              },
              {
                "kind": "account",
                "path": "vault"
              }
            ]
          }
        },
        {
          "name": "programCollateralAta",
          "docs": [
            "Program collateral pool ATA — slash destination."
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  103,
                  114,
                  97,
                  109,
                  95,
                  99,
                  111,
                  108,
                  108,
                  97,
                  116,
                  101,
                  114,
                  97,
                  108
                ]
              }
            ]
          }
        },
        {
          "name": "tokenProgram",
          "address": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "unwindCoLp",
      "docs": [
        "LP or user closes a co-LP position and distributes proceeds."
      ],
      "discriminator": [
        198,
        5,
        47,
        9,
        143,
        104,
        38,
        165
      ],
      "accounts": [
        {
          "name": "caller",
          "writable": true,
          "signer": true
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "vault.lp_address",
                "account": "vault"
              }
            ]
          }
        },
        {
          "name": "globalState",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  108,
                  111,
                  98,
                  97,
                  108,
                  95,
                  115,
                  116,
                  97,
                  116,
                  101
                ]
              }
            ]
          }
        },
        {
          "name": "coLpPosition",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  95,
                  108,
                  112,
                  95,
                  112,
                  111,
                  115,
                  105,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "co_lp_position.vault",
                "account": "coLpPosition"
              },
              {
                "kind": "account",
                "path": "co_lp_position.user",
                "account": "coLpPosition"
              },
              {
                "kind": "account",
                "path": "co_lp_position.nonce",
                "account": "coLpPosition"
              }
            ]
          }
        },
        {
          "name": "position",
          "docs": [
            "Orca Position account"
          ],
          "writable": true
        },
        {
          "name": "whirlpool",
          "docs": [
            "Orca Whirlpool account"
          ],
          "writable": true
        },
        {
          "name": "positionMint",
          "docs": [
            "Position NFT mint"
          ],
          "writable": true
        },
        {
          "name": "positionTokenAccount",
          "writable": true
        },
        {
          "name": "tickArrayLower",
          "writable": true
        },
        {
          "name": "tickArrayUpper",
          "writable": true
        },
        {
          "name": "positionCollateralAta",
          "writable": true
        },
        {
          "name": "positionWsxmrAta",
          "writable": true
        },
        {
          "name": "vaultCollateralAta",
          "writable": true
        },
        {
          "name": "userWsxmrAta",
          "writable": true
        },
        {
          "name": "collateralMint"
        },
        {
          "name": "wsxmrMint"
        },
        {
          "name": "tokenProgram",
          "address": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "userOpenCoLp",
      "docs": [
        "User pairs wsXMR with vault idle QQQx collateral to open a position."
      ],
      "discriminator": [
        136,
        164,
        114,
        237,
        179,
        193,
        71,
        131
      ],
      "accounts": [
        {
          "name": "user",
          "writable": true,
          "signer": true
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "vault.lp_address",
                "account": "vault"
              }
            ]
          }
        },
        {
          "name": "globalState",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  108,
                  111,
                  98,
                  97,
                  108,
                  95,
                  115,
                  116,
                  97,
                  116,
                  101
                ]
              }
            ]
          }
        },
        {
          "name": "coLpPosition",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  95,
                  108,
                  112,
                  95,
                  112,
                  111,
                  115,
                  105,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "vault"
              },
              {
                "kind": "account",
                "path": "user"
              },
              {
                "kind": "arg",
                "path": "nonce"
              }
            ]
          }
        },
        {
          "name": "positionMint",
          "docs": [
            "Position NFT mint (Token-2022 with metadata extensions) — created by the program"
          ],
          "writable": true
        },
        {
          "name": "positionTokenAccount",
          "docs": [
            "ATA holding the position NFT — created by the program"
          ],
          "writable": true
        },
        {
          "name": "position",
          "docs": [
            "Orca Position PDA (derived from position_mint)"
          ],
          "writable": true
        },
        {
          "name": "whirlpool",
          "docs": [
            "Orca Whirlpool account (mutated by increase_liquidity)"
          ],
          "writable": true
        },
        {
          "name": "tickArrayLower",
          "docs": [
            "Whirlpool-internal accounts (token_vault_a/b, token_badge_a/b,",
            "whirlpools_config_extension, metadata_update_auth, whirlpool_program) are",
            "passed via ctx.remaining_accounts — keeping them out of the struct avoids a",
            "~4KB try_accounts stack frame overflow."
          ],
          "writable": true
        },
        {
          "name": "tickArrayUpper",
          "writable": true
        },
        {
          "name": "positionCollateralAta",
          "docs": [
            "Program-owned QQQx ATA (position token_owner_account_a)"
          ],
          "writable": true
        },
        {
          "name": "positionWsxmrAta",
          "docs": [
            "Program-owned wsXMR ATA (position token_owner_account_b)"
          ],
          "writable": true
        },
        {
          "name": "userWsxmrAta",
          "writable": true
        },
        {
          "name": "vaultCollateralAta",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116,
                  95,
                  99,
                  111,
                  108,
                  108,
                  97,
                  116,
                  101,
                  114,
                  97,
                  108
                ]
              },
              {
                "kind": "account",
                "path": "vault"
              }
            ]
          }
        },
        {
          "name": "collateralMint"
        },
        {
          "name": "wsxmrMint"
        },
        {
          "name": "pythXmr"
        },
        {
          "name": "pythCollateral"
        },
        {
          "name": "tokenProgram",
          "address": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
        },
        {
          "name": "associatedTokenProgram",
          "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "wsxmrAmount",
          "type": "u64"
        },
        {
          "name": "nonce",
          "type": "u64"
        }
      ]
    },
    {
      "name": "withdrawCollateral",
      "discriminator": [
        115,
        135,
        168,
        106,
        139,
        214,
        138,
        150
      ],
      "accounts": [
        {
          "name": "lp",
          "writable": true,
          "signer": true
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "lp"
              }
            ]
          }
        },
        {
          "name": "globalState",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  108,
                  111,
                  98,
                  97,
                  108,
                  95,
                  115,
                  116,
                  97,
                  116,
                  101
                ]
              }
            ]
          }
        },
        {
          "name": "collateralMint"
        },
        {
          "name": "lpCollateralAta",
          "writable": true
        },
        {
          "name": "vaultCollateralAta",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116,
                  95,
                  99,
                  111,
                  108,
                  108,
                  97,
                  116,
                  101,
                  114,
                  97,
                  108
                ]
              },
              {
                "kind": "account",
                "path": "vault"
              }
            ]
          }
        },
        {
          "name": "pythXmr"
        },
        {
          "name": "pythCollateral"
        },
        {
          "name": "tokenProgram",
          "address": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "amount",
          "type": "u64"
        }
      ]
    },
    {
      "name": "withdrawCollateralReturns",
      "discriminator": [
        97,
        12,
        150,
        237,
        16,
        150,
        252,
        254
      ],
      "accounts": [
        {
          "name": "owner",
          "signer": true
        },
        {
          "name": "pendingReturns",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  101,
                  110,
                  100,
                  105,
                  110,
                  103,
                  95,
                  114,
                  101,
                  116,
                  117,
                  114,
                  110,
                  115
                ]
              },
              {
                "kind": "account",
                "path": "owner"
              }
            ]
          }
        },
        {
          "name": "globalState",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  108,
                  111,
                  98,
                  97,
                  108,
                  95,
                  115,
                  116,
                  97,
                  116,
                  101
                ]
              }
            ]
          }
        },
        {
          "name": "collateralMint"
        },
        {
          "name": "programCollateralAta",
          "docs": [
            "Program-owned collateral ATA (pending returns pool)"
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  103,
                  114,
                  97,
                  109,
                  95,
                  99,
                  111,
                  108,
                  108,
                  97,
                  116,
                  101,
                  114,
                  97,
                  108
                ]
              }
            ]
          }
        },
        {
          "name": "userCollateralAta",
          "writable": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
        }
      ],
      "args": []
    },
    {
      "name": "withdrawSolReturns",
      "discriminator": [
        164,
        179,
        69,
        189,
        226,
        88,
        188,
        16
      ],
      "accounts": [
        {
          "name": "owner",
          "writable": true,
          "signer": true
        },
        {
          "name": "pendingReturns",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  101,
                  110,
                  100,
                  105,
                  110,
                  103,
                  95,
                  114,
                  101,
                  116,
                  117,
                  114,
                  110,
                  115
                ]
              },
              {
                "kind": "account",
                "path": "owner"
              }
            ]
          }
        },
        {
          "name": "globalState",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  103,
                  108,
                  111,
                  98,
                  97,
                  108,
                  95,
                  115,
                  116,
                  97,
                  116,
                  101
                ]
              }
            ]
          }
        },
        {
          "name": "solEscrow",
          "docs": [
            "Program-owned SOL escrow account holding griefing deposits"
          ],
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  115,
                  111,
                  108,
                  95,
                  101,
                  115,
                  99,
                  114,
                  111,
                  119
                ]
              }
            ]
          }
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    }
  ],
  "accounts": [
    {
      "name": "burnRequest",
      "discriminator": [
        192,
        96,
        174,
        201,
        165,
        92,
        135,
        80
      ]
    },
    {
      "name": "coLpPosition",
      "discriminator": [
        107,
        75,
        56,
        133,
        93,
        159,
        197,
        5
      ]
    },
    {
      "name": "globalState",
      "discriminator": [
        163,
        46,
        74,
        168,
        216,
        123,
        133,
        98
      ]
    },
    {
      "name": "mintRequest",
      "discriminator": [
        60,
        88,
        16,
        213,
        180,
        138,
        14,
        225
      ]
    },
    {
      "name": "pendingReturns",
      "discriminator": [
        224,
        157,
        179,
        244,
        202,
        0,
        220,
        20
      ]
    },
    {
      "name": "vault",
      "discriminator": [
        211,
        8,
        232,
        43,
        2,
        152,
        117,
        119
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "zeroAddress",
      "msg": "Zero address provided"
    },
    {
      "code": 6001,
      "name": "zeroAmount",
      "msg": "Zero amount provided"
    },
    {
      "code": 6002,
      "name": "vaultAlreadyExists",
      "msg": "Vault already exists"
    },
    {
      "code": 6003,
      "name": "vaultDoesNotExist",
      "msg": "Vault does not exist"
    },
    {
      "code": 6004,
      "name": "vaultNotActive",
      "msg": "Vault not active"
    },
    {
      "code": 6005,
      "name": "insufficientCollateral",
      "msg": "Insufficient collateral"
    },
    {
      "code": 6006,
      "name": "exceedsMaxMargin",
      "msg": "Fee or reward exceeds maximum"
    },
    {
      "code": 6007,
      "name": "invalidMintRequest",
      "msg": "Invalid mint request"
    },
    {
      "code": 6008,
      "name": "invalidBurnRequest",
      "msg": "Invalid burn request"
    },
    {
      "code": 6009,
      "name": "mintAlreadyExists",
      "msg": "Mint request already exists"
    },
    {
      "code": 6010,
      "name": "burnAlreadyExists",
      "msg": "Burn request already exists"
    },
    {
      "code": 6011,
      "name": "invalidSecret",
      "msg": "Invalid secret"
    },
    {
      "code": 6012,
      "name": "invalidUserSecret",
      "msg": "Invalid user secret"
    },
    {
      "code": 6013,
      "name": "burnExceedsVaultDebt",
      "msg": "Burn exceeds vault debt"
    },
    {
      "code": 6014,
      "name": "invalidCommitment",
      "msg": "Invalid commitment"
    },
    {
      "code": 6015,
      "name": "pendingMintLock",
      "msg": "Pending mints must be resolved first"
    },
    {
      "code": 6016,
      "name": "invalidStatus",
      "msg": "Invalid status for operation"
    },
    {
      "code": 6017,
      "name": "timeoutNotReached",
      "msg": "Timeout not reached"
    },
    {
      "code": 6018,
      "name": "deadlineExpired",
      "msg": "Deadline expired"
    },
    {
      "code": 6019,
      "name": "deadlineNotExpired",
      "msg": "Deadline not yet expired"
    },
    {
      "code": 6020,
      "name": "vaultHealthy",
      "msg": "Vault is healthy, cannot liquidate"
    },
    {
      "code": 6021,
      "name": "insufficientDebt",
      "msg": "Insufficient debt"
    },
    {
      "code": 6022,
      "name": "unauthorized",
      "msg": "unauthorized"
    },
    {
      "code": 6023,
      "name": "invalidValue",
      "msg": "Invalid value"
    },
    {
      "code": 6024,
      "name": "stalePrice",
      "msg": "Stale or invalid price"
    },
    {
      "code": 6025,
      "name": "insufficientDeposit",
      "msg": "Insufficient deposit"
    },
    {
      "code": 6026,
      "name": "mathOverflow",
      "msg": "Arithmetic overflow"
    },
    {
      "code": 6027,
      "name": "unresolvedBurns",
      "msg": "Active burns must be resolved before liquidation"
    },
    {
      "code": 6028,
      "name": "poolNotInitialized",
      "msg": "Pool not initialized"
    },
    {
      "code": 6029,
      "name": "belowMinimumBurn",
      "msg": "Below minimum burn amount"
    },
    {
      "code": 6030,
      "name": "maxBurnRequestsReached",
      "msg": "Maximum burn requests per vault reached"
    },
    {
      "code": 6031,
      "name": "onlyUserCanInitiate",
      "msg": "Only user can initiate this operation"
    },
    {
      "code": 6032,
      "name": "burnInvalidatedByLiquidation",
      "msg": "Burn invalidated by liquidation"
    },
    {
      "code": 6033,
      "name": "maxVaultsReached",
      "msg": "Maximum vault count reached"
    },
    {
      "code": 6034,
      "name": "invalidConfig",
      "msg": "Invalid configuration value"
    },
    {
      "code": 6035,
      "name": "routerAlreadySet",
      "msg": "Liquidity router already set"
    },
    {
      "code": 6036,
      "name": "onlyRouter",
      "msg": "Only liquidity router can call this"
    },
    {
      "code": 6037,
      "name": "onlyDeployer",
      "msg": "Only deployer can call this"
    },
    {
      "code": 6038,
      "name": "mintNonceMismatch",
      "msg": "Vault mint nonce mismatch"
    },
    {
      "code": 6039,
      "name": "priceNormalizedToZero",
      "msg": "Price normalized to zero"
    },
    {
      "code": 6040,
      "name": "xmrAmountTooSmall",
      "msg": "XMR amount too small (minimum 1e4 atomic units)"
    },
    {
      "code": 6041,
      "name": "collateralDepegged",
      "msg": "Collateral at distress discount: minting paused"
    }
  ],
  "types": [
    {
      "name": "burnRequest",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "requestId",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "user",
            "type": "pubkey"
          },
          {
            "name": "lpVault",
            "type": "pubkey"
          },
          {
            "name": "wsxmrAmount",
            "docs": [
              "wsXMR burned (8 decimals)"
            ],
            "type": "u64"
          },
          {
            "name": "xmrAmount",
            "docs": [
              "Equivalent XMR atomic units (12 decimals)"
            ],
            "type": "u64"
          },
          {
            "name": "lockedCollateral",
            "docs": [
              "Base collateral locked for this burn"
            ],
            "type": "u64"
          },
          {
            "name": "rewardCollateral",
            "docs": [
              "Extra collateral locked as burn reward"
            ],
            "type": "u64"
          },
          {
            "name": "userClaimCommitment",
            "docs": [
              "User's Ed25519 commitment: keccak256(compress(secret · G))"
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "userPublicKey",
            "docs": [
              "User's compressed Ed25519 public spend key (for Monero address derivation + slash verification)"
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "userViewKey",
            "docs": [
              "User's Ed25519 public view key (x-coordinate)"
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "xmrPriceAtRequest",
            "docs": [
              "XMR price snapshot at request time (par settlement for slashes)"
            ],
            "type": "u64"
          },
          {
            "name": "secretHash",
            "docs": [
              "Hash of LP's secret (set in propose_hash)"
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "lpPublicSpendKey",
            "docs": [
              "LP's Ed25519 public spend key (x-coordinate) — set at propose_hash"
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "lpPublicViewKey",
            "docs": [
              "LP's Ed25519 public view key (x-coordinate) — set at propose_hash"
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "revealedSecret",
            "docs": [
              "LP's revealed Ed25519 secret (set by reveal_burn_secret / finalize_burn)"
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "deadline",
            "docs": [
              "Deadline unix timestamp"
            ],
            "type": "i64"
          },
          {
            "name": "vaultLiquidationNonce",
            "docs": [
              "Snapshot of vault liquidation nonce at creation"
            ],
            "type": "u64"
          },
          {
            "name": "normalizedDebtAmount",
            "docs": [
              "Normalized debt amount deducted at settlement (0 until then — debt is NOT",
              "reduced at request time, eliminating index-shift debt inflation bugs)"
            ],
            "type": "u64"
          },
          {
            "name": "abandoned",
            "docs": [
              "True when the LP abandoned a PROPOSED burn — the user's wsXMR remains",
              "claimable via resolve_declined_proposal (requires userSecret reveal)"
            ],
            "type": "bool"
          },
          {
            "name": "status",
            "type": {
              "defined": {
                "name": "burnStatus"
              }
            }
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "burnStatus",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "invalid"
          },
          {
            "name": "requested"
          },
          {
            "name": "proposed"
          },
          {
            "name": "committed"
          },
          {
            "name": "completed"
          },
          {
            "name": "slashed"
          },
          {
            "name": "cancelled"
          }
        ]
      }
    },
    {
      "name": "coLpPosition",
      "docs": [
        "A co-LP position: a user pairs wsXMR with an LP vault's idle QQQx collateral",
        "to open a concentrated-liquidity position on Orca Whirlpools (EVM",
        "PositionMetadata parity). The vault manager program is the position authority;",
        "the Orca Position account is referenced by `position_address`."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "vault",
            "docs": [
              "LP vault that supplied the collateral leg"
            ],
            "type": "pubkey"
          },
          {
            "name": "user",
            "docs": [
              "User that supplied the wsXMR leg"
            ],
            "type": "pubkey"
          },
          {
            "name": "collateralOriginal",
            "docs": [
              "Raw QQQx deployed from the vault (8 decimals)"
            ],
            "type": "u64"
          },
          {
            "name": "wsxmrOriginal",
            "docs": [
              "wsXMR deployed by the user (8 decimals)"
            ],
            "type": "u64"
          },
          {
            "name": "tickLower",
            "docs": [
              "Lower tick of the concentrated range"
            ],
            "type": "i32"
          },
          {
            "name": "tickUpper",
            "docs": [
              "Upper tick of the concentrated range"
            ],
            "type": "i32"
          },
          {
            "name": "liquidity",
            "docs": [
              "Liquidity units deployed (Orca Position.liquidity)"
            ],
            "type": "u128"
          },
          {
            "name": "positionAddress",
            "docs": [
              "Orca Whirlpools Position account address"
            ],
            "type": "pubkey"
          },
          {
            "name": "createdAt",
            "docs": [
              "Unix timestamp of position creation"
            ],
            "type": "i64"
          },
          {
            "name": "nonce",
            "docs": [
              "Nonce used in the PDA seed (global request nonce at creation)"
            ],
            "type": "u64"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "globalState",
      "serialization": "bytemuck",
      "repr": {
        "kind": "c"
      },
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "authority",
            "docs": [
              "Deployer/admin pubkey (one-time router setup)"
            ],
            "type": "pubkey"
          },
          {
            "name": "wsxmrMint",
            "docs": [
              "wsXMR SPL Token 2022 mint address"
            ],
            "type": "pubkey"
          },
          {
            "name": "collateralMint",
            "docs": [
              "Collateral SPL token mint (raw QQQx, no yield wrapper)"
            ],
            "type": "pubkey"
          },
          {
            "name": "liquidityRouter",
            "docs": [
              "Authorized liquidity router program"
            ],
            "type": "pubkey"
          },
          {
            "name": "pythXmrFeed",
            "docs": [
              "Pyth XMR/USD price feed account"
            ],
            "type": "pubkey"
          },
          {
            "name": "globalTotalDebt",
            "docs": [
              "Total wsXMR debt across all vaults (8 decimals)"
            ],
            "type": "u64"
          },
          {
            "name": "globalDebtIndex",
            "docs": [
              "Debt multiplier for O(1) proportional forgiveness (scaled 1e18, stored as u64).",
              "Fixed at INITIAL_DEBT_INDEX — no buy-and-burn modifies it, but the",
              "normalized-debt machinery is retained for EVM accounting parity."
            ],
            "type": "u64"
          },
          {
            "name": "globalPendingCollateral",
            "docs": [
              "Pending collateral withdrawals queued in PendingReturns accounts.",
              "Backed by the program_collateral_ata pool."
            ],
            "type": "u64"
          },
          {
            "name": "globalPendingSol",
            "docs": [
              "Pending SOL/lamport withdrawals queued in PendingReturns accounts"
            ],
            "type": "u64"
          },
          {
            "name": "globalBadDebt",
            "docs": [
              "Unbacked wsXMR from liquidation shortfalls"
            ],
            "type": "u64"
          },
          {
            "name": "globalPendingBurnDebt",
            "docs": [
              "wsXMR debt currently locked in pending burn requests"
            ],
            "type": "u64"
          },
          {
            "name": "requestNonce",
            "docs": [
              "Global nonce for request ID generation"
            ],
            "type": "u64"
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "reserved",
            "docs": [
              "Explicit padding so the struct is Pod-compatible (no implicit alignment padding)"
            ],
            "type": {
              "array": [
                "u8",
                7
              ]
            }
          }
        ]
      }
    },
    {
      "name": "mintRequest",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "requestId",
            "docs": [
              "Unique request identifier (hash of initiator+lp+xmr_amount+commitment+nonce)"
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "initiator",
            "docs": [
              "Who paid the griefing deposit"
            ],
            "type": "pubkey"
          },
          {
            "name": "recipient",
            "docs": [
              "Destination for minted wsXMR"
            ],
            "type": "pubkey"
          },
          {
            "name": "lpVault",
            "docs": [
              "LP vault pubkey"
            ],
            "type": "pubkey"
          },
          {
            "name": "xmrAmount",
            "docs": [
              "XMR atomic units (12 decimals)"
            ],
            "type": "u64"
          },
          {
            "name": "wsxmrAmount",
            "docs": [
              "wsXMR amount (8 decimals)"
            ],
            "type": "u64"
          },
          {
            "name": "feeAmount",
            "docs": [
              "Portion of wsxmr_amount going to LP as fee"
            ],
            "type": "u64"
          },
          {
            "name": "claimCommitment",
            "docs": [
              "Ed25519 commitment: keccak256(compress(secret · G)) binding the user's secret"
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "userPublicKey",
            "docs": [
              "User's compressed Ed25519 public spend key (for Monero address derivation)"
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "lpPublicSpendKey",
            "docs": [
              "LP's Ed25519 public spend key (x-coordinate) — set at provide_lp_key"
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "lpPublicViewKey",
            "docs": [
              "LP's Ed25519 public view key (x-coordinate) — set at provide_lp_key"
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "lpCommitment",
            "docs": [
              "LP's Ed25519 commitment: keccak256(compress(lp_secret · G))"
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "timeout",
            "docs": [
              "Expiry unix timestamp (also reused as the LP claim-window deadline for",
              "KeyCancelled / ExpiredReady states)"
            ],
            "type": "i64"
          },
          {
            "name": "griefingDeposit",
            "docs": [
              "SOL lamports deposited as anti-spam"
            ],
            "type": "u64"
          },
          {
            "name": "lockedCollateral",
            "docs": [
              "Collateral shares locked as the key bond (provide_lp_key) / par lock (set_mint_ready)"
            ],
            "type": "u64"
          },
          {
            "name": "xmrPriceAtReady",
            "docs": [
              "XMR price snapshot at set_mint_ready (par settlement)"
            ],
            "type": "u64"
          },
          {
            "name": "normalizedDebtAmount",
            "docs": [
              "Normalized debt amount stored for consistent accounting"
            ],
            "type": "u64"
          },
          {
            "name": "vaultMintNonce",
            "docs": [
              "Snapshot of vault's mint_nonce at creation (for liquidation invalidation)"
            ],
            "type": "u64"
          },
          {
            "name": "revealedSecret",
            "docs": [
              "User's revealed Ed25519 secret (set by reveal_secret, read by finalize_mint)"
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "status",
            "type": {
              "defined": {
                "name": "mintStatus"
              }
            }
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "mintStatus",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "invalid"
          },
          {
            "name": "pending"
          },
          {
            "name": "keyProvided"
          },
          {
            "name": "ready"
          },
          {
            "name": "secretRevealed"
          },
          {
            "name": "completed"
          },
          {
            "name": "cancelled"
          },
          {
            "name": "keyCancelled"
          },
          {
            "name": "expiredReady"
          }
        ]
      }
    },
    {
      "name": "pendingReturns",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "collateralAmount",
            "docs": [
              "Pending collateral token withdrawals"
            ],
            "type": "u64"
          },
          {
            "name": "solAmount",
            "docs": [
              "Pending SOL (lamport) withdrawals"
            ],
            "type": "u64"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "vault",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "lpAddress",
            "docs": [
              "LP owner of this vault"
            ],
            "type": "pubkey"
          },
          {
            "name": "collateralAmount",
            "docs": [
              "Raw QQQx collateral held — TOTAL model: includes locked_collateral, so",
              "available = collateral_amount - locked_collateral - deployed_collateral"
            ],
            "type": "u64"
          },
          {
            "name": "lockedCollateral",
            "docs": [
              "Collateral reserved for pending burns/mints (still inside collateral_amount)"
            ],
            "type": "u64"
          },
          {
            "name": "normalizedDebt",
            "docs": [
              "Normalized debt: actual_debt = normalized_debt * global_debt_index / 1e18"
            ],
            "type": "u64"
          },
          {
            "name": "pendingDebt",
            "docs": [
              "Reserved capacity for pending mints (not liquidatable)"
            ],
            "type": "u64"
          },
          {
            "name": "maxMintBps",
            "docs": [
              "LP-configured max single mint size in basis points (0 = no limit)"
            ],
            "type": "u16"
          },
          {
            "name": "mintGriefingDeposit",
            "docs": [
              "SOL lamports required per mint request (anti-spam griefing deposit)"
            ],
            "type": "u64"
          },
          {
            "name": "mintFeeBps",
            "docs": [
              "Fee LP charges for minting (basis points, max 1000)"
            ],
            "type": "u16"
          },
          {
            "name": "burnRewardBps",
            "docs": [
              "Reward LP pays to incentivize burning (basis points, max 1000)"
            ],
            "type": "u16"
          },
          {
            "name": "liquidationNonce",
            "docs": [
              "Incremented on liquidation to invalidate all pending burns"
            ],
            "type": "u64"
          },
          {
            "name": "mintNonce",
            "docs": [
              "Incremented on liquidation to invalidate all pending mints"
            ],
            "type": "u64"
          },
          {
            "name": "minBurnAmount",
            "docs": [
              "LP-configurable minimum burn amount (0 = use global default)"
            ],
            "type": "u64"
          },
          {
            "name": "activeBurnCount",
            "docs": [
              "Number of currently active (non-terminal) burn requests"
            ],
            "type": "u32"
          },
          {
            "name": "pendingMintCount",
            "docs": [
              "Number of mints in READY state — blocks state-changing vault ops until resolved"
            ],
            "type": "u32"
          },
          {
            "name": "mintTimeoutSeconds",
            "docs": [
              "LP-configured mint request timeout in seconds (EVM mintTimeoutBlocks parity)"
            ],
            "type": "i64"
          },
          {
            "name": "burnTimeoutSeconds",
            "docs": [
              "LP-configured burn request timeout in seconds (EVM burnTimeoutBlocks parity)"
            ],
            "type": "i64"
          },
          {
            "name": "whitelistedMinters",
            "docs": [
              "Whitelisted minters that bypass the griefing deposit (EVM whitelistedMinters parity)"
            ],
            "type": {
              "array": [
                "pubkey",
                32
              ]
            }
          },
          {
            "name": "whitelistedMinterCount",
            "docs": [
              "Number of entries in whitelisted_minters"
            ],
            "type": "u32"
          },
          {
            "name": "deployedCollateral",
            "docs": [
              "QQQx deployed into co-LP positions (excluded from liquid balance)"
            ],
            "type": "u64"
          },
          {
            "name": "maxCoLpRangeBps",
            "docs": [
              "LP's preferred max co-LP range width in basis points (EVM maxCoLPRangeBps parity)"
            ],
            "type": "u16"
          },
          {
            "name": "active",
            "type": "bool"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    }
  ]
};
