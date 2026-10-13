/**
 * Hand-authored IDL for wrapsynth-vault-manager (anchor-lang 0.30.x).
 * Discriminators computed via sha256("global:<instruction_name>")[0..8]
 * and sha256("account:<StructName>")[0..8].
 */

export type WrapsynthVaultManager = {
  address: "EZ1hsgYwmqmCY5Gzw9mwnJnJE4PJcKX5hHw5MZXk2ssy";
  metadata: { name: "wrapsynthVaultManager"; version: "0.1.0"; spec: "0.1.0" };
  instructions: any[];
  accounts: any[];
  types: any[];
  errors: any[];
};

export const IDL: any = {
  address: "EZ1hsgYwmqmCY5Gzw9mwnJnJE4PJcKX5hHw5MZXk2ssy",
  metadata: { name: "wrapsynthVaultManager", version: "0.1.0", spec: "0.1.0" },
  instructions: [
    {
      name: "initialize",
      discriminator: [175,175,109,31,13,152,155,237],
      accounts: [
        { name: "authority", writable: true, signer: true },
        { name: "globalState", writable: true },
        { name: "wsxmrMint", writable: true },
        { name: "tokenProgram" },
        { name: "systemProgram" },
        { name: "rent" },
      ],
      args: [
        { name: "pythXmrFeed", type: "pubkey" },
        { name: "collateralMint", type: "pubkey" },
      ]
    },
    {
      name: "setLiquidityRouter",
      discriminator: [4,57,195,0,242,41,192,236],
      accounts: [
        { name: "authority", signer: true },
        { name: "globalState", writable: true },
      ],
      args: [
        { name: "router", type: "pubkey" },
      ]
    },
    {
      name: "createVault",
      discriminator: [29,237,247,208,193,82,54,135],
      accounts: [
        { name: "lp", writable: true, signer: true },
        { name: "vault", writable: true },
        { name: "globalState", writable: true },
        { name: "systemProgram" },
      ],
      args: []
    },
    {
      name: "initializeVaultCollateral",
      discriminator: [64,160,30,204,90,27,120,130],
      accounts: [
        { name: "lp", writable: true, signer: true },
        { name: "vault" },
        { name: "collateralMint" },
        { name: "vaultCollateralAta", writable: true },
        { name: "tokenProgram" },
        { name: "systemProgram" },
      ],
      args: []
    },
    {
      name: "depositCollateralShares",
      discriminator: [20,240,179,194,143,85,84,23],
      accounts: [
        { name: "lp", writable: true, signer: true },
        { name: "vault", writable: true },
        { name: "globalState", writable: true },
        { name: "collateralMint" },
        { name: "lpCollateralAta", writable: true },
        { name: "vaultCollateralAta", writable: true },
        { name: "pythXmr" },
        { name: "pythCollateral" },
        { name: "pythSusdeRr" },
        { name: "tokenProgram" },
        { name: "systemProgram" },
      ],
      args: [
        { name: "amount", type: "u64" },
      ]
    },
    {
      name: "withdrawCollateral",
      discriminator: [115,135,168,106,139,214,138,150],
      accounts: [
        { name: "lp", writable: true, signer: true },
        { name: "vault", writable: true },
        { name: "globalState", writable: true },
        { name: "collateralMint" },
        { name: "lpCollateralAta", writable: true },
        { name: "vaultCollateralAta", writable: true },
        { name: "pythXmr" },
        { name: "pythCollateral" },
        { name: "pythSusdeRr" },
        { name: "tokenProgram" },
        { name: "systemProgram" },
      ],
      args: [
        { name: "amount", type: "u64" },
      ]
    },
    {
      name: "setMintGriefingDeposit",
      discriminator: [65,157,253,230,59,150,28,102],
      accounts: [
        { name: "lp", signer: true },
        { name: "vault", writable: true },
      ],
      args: [
        { name: "deposit", type: "u64" },
      ]
    },
    {
      name: "setVaultMarketMetrics",
      discriminator: [149,233,151,73,97,154,111,224],
      accounts: [
        { name: "lp", signer: true },
        { name: "vault", writable: true },
      ],
      args: [
        { name: "mintFeeBps", type: "u16" },
        { name: "burnRewardBps", type: "u16" },
      ]
    },
    {
      name: "setMaxMintBps",
      discriminator: [179,42,1,225,89,24,172,5],
      accounts: [
        { name: "lp", signer: true },
        { name: "vault", writable: true },
      ],
      args: [
        { name: "maxMintBps", type: "u16" },
      ]
    },
    {
      name: "setMinBurnAmount",
      discriminator: [88,59,48,178,80,23,100,218],
      accounts: [
        { name: "lp", signer: true },
        { name: "vault", writable: true },
      ],
      args: [
        { name: "minAmount", type: "u64" },
      ]
    },
    {
      name: "setMintTimeout",
      discriminator: [244,81,151,11,220,66,153,116],
      accounts: [
        { name: "lp", signer: true },
        { name: "vault", writable: true },
      ],
      args: [
        { name: "seconds", type: "i64" },
      ]
    },
    {
      name: "setBurnTimeout",
      discriminator: [147,112,29,38,104,223,169,84],
      accounts: [
        { name: "lp", signer: true },
        { name: "vault", writable: true },
      ],
      args: [
        { name: "seconds", type: "i64" },
      ]
    },
    {
      name: "setMinterWhitelist",
      discriminator: [194,112,167,67,242,7,54,102],
      accounts: [
        { name: "lp", signer: true },
        { name: "vault", writable: true },
      ],
      args: [
        { name: "minter", type: "pubkey" },
        { name: "whitelisted", type: "bool" },
      ]
    },
    {
      name: "batchSetMinterWhitelist",
      discriminator: [63,118,158,211,114,216,51,108],
      accounts: [
        { name: "lp", signer: true },
        { name: "vault", writable: true },
      ],
      args: [
        { name: "minters", type: {"vec":"pubkey"} },
        { name: "whitelisted", type: "bool" },
      ]
    },
    {
      name: "deactivateVault",
      discriminator: [152,132,22,236,200,128,124,174],
      accounts: [
        { name: "lp", signer: true },
        { name: "vault", writable: true },
        { name: "globalState", writable: true },
      ],
      args: []
    },
    {
      name: "initiateMint",
      discriminator: [198,6,136,107,232,232,179,158],
      accounts: [
        { name: "initiator", writable: true, signer: true },
        { name: "recipient" },
        { name: "vault", writable: true },
        { name: "globalState", writable: true },
        { name: "mintRequest", writable: true },
        { name: "griefingEscrow", writable: true },
        { name: "initiatorPendingReturns", writable: true },
        { name: "pythXmr" },
        { name: "pythCollateral" },
        { name: "pythSusdeRr" },
        { name: "systemProgram" },
      ],
      args: [
        { name: "xmrAmount", type: "u64" },
        { name: "claimCommitment", type: {"array":["u8",32]} },
        { name: "userPublicKey", type: {"array":["u8",32]} },
        { name: "requestId", type: {"array":["u8",32]} },
      ]
    },
    {
      name: "provideLpKey",
      discriminator: [160,213,144,181,224,59,53,148],
      accounts: [
        { name: "lp", signer: true },
        { name: "vault", writable: true },
        { name: "globalState", writable: true },
        { name: "mintRequest", writable: true },
        { name: "pythXmr" },
        { name: "pythCollateral" },
        { name: "pythSusdeRr" },
      ],
      args: [
        { name: "lpPublicSpendKey", type: {"array":["u8",32]} },
        { name: "lpPublicViewKey", type: {"array":["u8",32]} },
        { name: "lpCommitment", type: {"array":["u8",32]} },
      ]
    },
    {
      name: "setMintReady",
      discriminator: [109,66,111,178,198,143,235,173],
      accounts: [
        { name: "lp", signer: true },
        { name: "vault", writable: true },
        { name: "globalState", writable: true },
        { name: "mintRequest", writable: true },
        { name: "pythXmr" },
        { name: "pythCollateral" },
        { name: "pythSusdeRr" },
      ],
      args: []
    },
    {
      name: "revealSecret",
      discriminator: [126,156,142,60,92,135,177,144],
      accounts: [
        { name: "caller", writable: true, signer: true },
        { name: "mintRequest", writable: true },
      ],
      args: [
        { name: "secret", type: {"array":["u8",32]} },
      ]
    },
    {
      name: "finalizeMint",
      discriminator: [77,12,218,47,57,4,38,239],
      accounts: [
        { name: "caller", writable: true, signer: true },
        { name: "vault", writable: true },
        { name: "globalState", writable: true },
        { name: "mintRequest", writable: true },
        { name: "wsxmrMint", writable: true },
        { name: "recipientWsxmrAta", writable: true },
        { name: "lpWsxmrAta", writable: true },
        { name: "pendingReturns", writable: true },
        { name: "pythXmr" },
        { name: "pythCollateral" },
        { name: "pythSusdeRr" },
        { name: "tokenProgram" },
        { name: "systemProgram" },
      ],
      args: []
    },
    {
      name: "cancelMint",
      discriminator: [61,87,130,22,64,57,137,57],
      accounts: [
        { name: "caller", writable: true, signer: true },
        { name: "vault", writable: true },
        { name: "globalState", writable: true },
        { name: "mintRequest", writable: true },
        { name: "initiatorReturns", writable: true },
        { name: "lpReturns", writable: true },
        { name: "wsxmrMint", writable: true },
        { name: "recipientWsxmrAta", writable: true },
        { name: "lpWsxmrAta", writable: true },
        { name: "pythXmr" },
        { name: "pythCollateral" },
        { name: "pythSusdeRr" },
        { name: "tokenProgram" },
        { name: "systemProgram" },
      ],
      args: []
    },
    {
      name: "abandonKeyProvidedMint",
      discriminator: [126,73,203,249,82,23,51,97],
      accounts: [
        { name: "lp", signer: true },
        { name: "vault", writable: true },
        { name: "globalState", writable: true },
        { name: "mintRequest", writable: true },
        { name: "lpReturns", writable: true },
        { name: "systemProgram" },
      ],
      args: [
        { name: "lpSecret", type: {"array":["u8",32]} },
      ]
    },
    {
      name: "reclaimParkedDeposit",
      discriminator: [125,53,47,58,183,17,36,165],
      accounts: [
        { name: "caller", writable: true, signer: true },
        { name: "vault", writable: true },
        { name: "globalState", writable: true },
        { name: "mintRequest", writable: true },
        { name: "initiatorReturns", writable: true },
        { name: "systemProgram" },
      ],
      args: []
    },
    {
      name: "claimGriefingDeposit",
      discriminator: [217,250,223,96,239,197,165,147],
      accounts: [
        { name: "lp", signer: true },
        { name: "vault", writable: true },
        { name: "globalState", writable: true },
        { name: "mintRequest", writable: true },
        { name: "lpReturns", writable: true },
        { name: "systemProgram" },
      ],
      args: [
        { name: "lpSecret", type: {"array":["u8",32]} },
      ]
    },
    {
      name: "sweepUnclaimedExpiredMint",
      discriminator: [175,118,222,107,184,44,31,1],
      accounts: [
        { name: "caller", writable: true, signer: true },
        { name: "vault", writable: true },
        { name: "globalState", writable: true },
        { name: "mintRequest", writable: true },
        { name: "initiatorReturns", writable: true },
        { name: "systemProgram" },
      ],
      args: []
    },
    {
      name: "requestBurn",
      discriminator: [222,82,224,225,201,96,24,213],
      accounts: [
        { name: "user", writable: true, signer: true },
        { name: "vault", writable: true },
        { name: "globalState", writable: true },
        { name: "burnRequest", writable: true },
        { name: "wsxmrMint", writable: true },
        { name: "userWsxmrAta", writable: true },
        { name: "pythXmr" },
        { name: "pythCollateral" },
        { name: "pythSusdeRr" },
        { name: "tokenProgram" },
        { name: "systemProgram" },
      ],
      args: [
        { name: "wsxmrAmount", type: "u64" },
        { name: "claimCommitment", type: {"array":["u8",32]} },
        { name: "userPublicKey", type: {"array":["u8",32]} },
        { name: "userViewKey", type: {"array":["u8",32]} },
        { name: "requestId", type: {"array":["u8",32]} },
      ]
    },
    {
      name: "requestBurnFromRouter",
      discriminator: [165,189,125,181,77,206,115,69],
      accounts: [
        { name: "user", writable: true, signer: true },
        { name: "vault", writable: true },
        { name: "globalState", writable: true },
        { name: "burnRequest", writable: true },
        { name: "wsxmrMint", writable: true },
        { name: "userWsxmrAta", writable: true },
        { name: "pythXmr" },
        { name: "pythCollateral" },
        { name: "pythSusdeRr" },
        { name: "tokenProgram" },
        { name: "systemProgram" },
      ],
      args: [
        { name: "wsxmrAmount", type: "u64" },
        { name: "claimCommitment", type: {"array":["u8",32]} },
        { name: "userPublicKey", type: {"array":["u8",32]} },
        { name: "userViewKey", type: {"array":["u8",32]} },
        { name: "requestId", type: {"array":["u8",32]} },
      ]
    },
    {
      name: "proposeHash",
      discriminator: [45,6,224,60,98,64,142,49],
      accounts: [
        { name: "lp", signer: true },
        { name: "vault" },
        { name: "burnRequest", writable: true },
      ],
      args: [
        { name: "secretHash", type: {"array":["u8",32]} },
        { name: "lpPublicSpendKey", type: {"array":["u8",32]} },
        { name: "lpPublicViewKey", type: {"array":["u8",32]} },
      ]
    },
    {
      name: "confirmMoneroLock",
      discriminator: [39,152,65,15,181,0,117,242],
      accounts: [
        { name: "user", signer: true },
        { name: "burnRequest", writable: true },
      ],
      args: []
    },
    {
      name: "revealBurnSecret",
      discriminator: [119,200,232,221,74,199,52,18],
      accounts: [
        { name: "caller", writable: true, signer: true },
        { name: "burnRequest", writable: true },
      ],
      args: [
        { name: "secret", type: {"array":["u8",32]} },
      ]
    },
    {
      name: "settleBurn",
      discriminator: [12,139,212,132,234,51,0,8],
      accounts: [
        { name: "caller", writable: true, signer: true },
        { name: "vaultLp" },
        { name: "vault", writable: true },
        { name: "globalState", writable: true },
        { name: "burnRequest", writable: true },
        { name: "userPendingReturns", writable: true },
        { name: "pythXmr" },
        { name: "pythCollateral" },
        { name: "pythSusdeRr" },
        { name: "systemProgram" },
      ],
      args: []
    },
    {
      name: "finalizeBurn",
      discriminator: [214,238,193,136,253,151,249,13],
      accounts: [
        { name: "caller", writable: true, signer: true },
        { name: "vaultLp" },
        { name: "vault", writable: true },
        { name: "globalState", writable: true },
        { name: "burnRequest", writable: true },
        { name: "userPendingReturns", writable: true },
        { name: "pythXmr" },
        { name: "pythCollateral" },
        { name: "pythSusdeRr" },
        { name: "systemProgram" },
      ],
      args: [
        { name: "secret", type: {"array":["u8",32]} },
      ]
    },
    {
      name: "claimSlashedCollateral",
      discriminator: [201,11,233,168,153,45,88,181],
      accounts: [
        { name: "user", writable: true, signer: true },
        { name: "vaultLp" },
        { name: "vault", writable: true },
        { name: "globalState", writable: true },
        { name: "burnRequest", writable: true },
        { name: "userPendingReturns", writable: true },
        { name: "pythXmr" },
        { name: "pythCollateral" },
        { name: "pythSusdeRr" },
        { name: "systemProgram" },
      ],
      args: [
        { name: "userSecret", type: {"array":["u8",32]} },
      ]
    },
    {
      name: "abortBurn",
      discriminator: [42,251,42,181,42,89,207,8],
      accounts: [
        { name: "caller", writable: true, signer: true },
        { name: "vault", writable: true },
        { name: "globalState", writable: true },
        { name: "burnRequest", writable: true },
        { name: "wsxmrMint", writable: true },
        { name: "userWsxmrAta", writable: true },
        { name: "tokenProgram" },
        { name: "systemProgram" },
      ],
      args: []
    },
    {
      name: "forceSettleBurn",
      discriminator: [164,19,246,100,252,209,204,65],
      accounts: [
        { name: "caller", writable: true, signer: true },
        { name: "vault", writable: true },
        { name: "globalState", writable: true },
        { name: "burnRequest", writable: true },
        { name: "userPendingReturns", writable: true },
        { name: "pythXmr" },
        { name: "pythCollateral" },
        { name: "pythSusdeRr" },
        { name: "systemProgram" },
      ],
      args: []
    },
    {
      name: "resolveDeclinedProposal",
      discriminator: [22,90,112,173,227,128,118,7],
      accounts: [
        { name: "caller", writable: true, signer: true },
        { name: "vault", writable: true },
        { name: "globalState", writable: true },
        { name: "burnRequest", writable: true },
        { name: "wsxmrMint", writable: true },
        { name: "userWsxmrAta", writable: true },
        { name: "tokenProgram" },
        { name: "systemProgram" },
      ],
      args: [
        { name: "userSecret", type: {"array":["u8",32]} },
      ]
    },
    {
      name: "abandonProposedBurn",
      discriminator: [126,241,188,48,240,98,145,149],
      accounts: [
        { name: "lp", signer: true },
        { name: "vault", writable: true },
        { name: "globalState", writable: true },
        { name: "burnRequest", writable: true },
        { name: "systemProgram" },
      ],
      args: []
    },
    {
      name: "resolveBurnForLiquidation",
      discriminator: [19,207,91,53,234,124,111,87],
      accounts: [
        { name: "caller", writable: true, signer: true },
        { name: "vault", writable: true },
        { name: "globalState", writable: true },
        { name: "burnRequest", writable: true },
        { name: "userPendingReturns", writable: true },
        { name: "wsxmrMint", writable: true },
        { name: "userWsxmrAta", writable: true },
        { name: "pythXmr" },
        { name: "pythCollateral" },
        { name: "pythSusdeRr" },
        { name: "tokenProgram" },
        { name: "systemProgram" },
      ],
      args: []
    },
    {
      name: "executeLiquidation",
      discriminator: [189,55,38,121,165,84,96,124],
      accounts: [
        { name: "liquidator", writable: true, signer: true },
        { name: "vault", writable: true },
        { name: "globalState", writable: true },
        { name: "wsxmrMint", writable: true },
        { name: "collateralMint" },
        { name: "liquidatorWsxmrAta", writable: true },
        { name: "liquidatorCollateralAta", writable: true },
        { name: "vaultCollateralAta", writable: true },
        { name: "pythXmr" },
        { name: "pythCollateral" },
        { name: "pythSusdeRr" },
        { name: "tokenProgram" },
        { name: "systemProgram" },
      ],
      args: [
        { name: "debtToClear", type: "u64" },
      ]
    },
    {
      name: "backstopVault",
      discriminator: [24,140,147,86,8,128,184,75],
      accounts: [
        { name: "newLp", writable: true, signer: true },
        { name: "oldVault", writable: true },
        { name: "newVault", writable: true },
        { name: "globalState", writable: true },
        { name: "pythXmr" },
        { name: "pythCollateral" },
        { name: "pythSusdeRr" },
        { name: "systemProgram" },
      ],
      args: []
    },
    {
      name: "setMaxCoLpRange",
      discriminator: [50,5,149,213,22,184,136,177],
      accounts: [
        { name: "lp", signer: true },
        { name: "vault", writable: true },
      ],
      args: [
        { name: "bps", type: "u16" },
      ]
    },
    {
      name: "userOpenCoLp",
      discriminator: [136,164,114,237,179,193,71,131],
      accounts: [
        { name: "user", writable: true, signer: true },
        { name: "vault", writable: true },
        { name: "globalState", writable: true },
        { name: "coLpPosition", writable: true },
        { name: "positionMint", writable: true, signer: true },
        { name: "positionTokenAccount", writable: true },
        { name: "position", writable: true },
        { name: "whirlpool", writable: true },
        { name: "tickArrayLower", writable: true },
        { name: "tickArrayUpper", writable: true },
        { name: "positionSusdeAta", writable: true },
        { name: "positionWsxmrAta", writable: true },
        { name: "userWsxmrAta", writable: true },
        { name: "vaultCollateralAta", writable: true },
        { name: "collateralMint" },
        { name: "wsxmrMint" },
        { name: "pythXmr" },
        { name: "pythCollateral" },
        { name: "pythSusdeRr" },
        { name: "tokenProgram" },
        { name: "associatedTokenProgram" },
        { name: "systemProgram" },
      ],
      args: [
        { name: "wsxmrAmount", type: "u64" },
        { name: "nonce", type: "u64" },
      ]
    },
    {
      name: "collectCoLpFees",
      discriminator: [108,252,128,173,124,40,16,33],
      accounts: [
        { name: "caller", writable: true, signer: true },
        { name: "vault", writable: true },
        { name: "globalState", writable: true },
        { name: "coLpPosition", writable: true },
        { name: "position", writable: true },
        { name: "whirlpool", writable: true },
        { name: "positionTokenAccount", writable: true },
        { name: "positionSusdeAta", writable: true },
        { name: "positionWsxmrAta", writable: true },
        { name: "vaultCollateralAta", writable: true },
        { name: "userWsxmrAta", writable: true },
        { name: "collateralMint" },
        { name: "wsxmrMint" },
        { name: "tokenProgram" },
        { name: "systemProgram" },
      ],
      args: []
    },
    {
      name: "unwindCoLp",
      discriminator: [198,5,47,9,143,104,38,165],
      accounts: [
        { name: "caller", writable: true, signer: true },
        { name: "vault", writable: true },
        { name: "globalState", writable: true },
        { name: "coLpPosition", writable: true },
        { name: "position", writable: true },
        { name: "whirlpool", writable: true },
        { name: "positionMint", writable: true },
        { name: "positionTokenAccount", writable: true },
        { name: "tickArrayLower", writable: true },
        { name: "tickArrayUpper", writable: true },
        { name: "positionSusdeAta", writable: true },
        { name: "positionWsxmrAta", writable: true },
        { name: "vaultCollateralAta", writable: true },
        { name: "userWsxmrAta", writable: true },
        { name: "collateralMint" },
        { name: "wsxmrMint" },
        { name: "tokenProgram" },
        { name: "systemProgram" },
      ],
      args: []
    },
    {
      name: "rebalanceCoLp",
      discriminator: [54,103,200,77,47,2,60,204],
      accounts: [
        { name: "caller", writable: true, signer: true },
        { name: "vault", writable: true },
        { name: "globalState", writable: true },
        { name: "coLpPosition", writable: true },
        { name: "position", writable: true },
        { name: "whirlpool", writable: true },
        { name: "positionTokenAccount", writable: true },
        { name: "tickArrayLower", writable: true },
        { name: "tickArrayUpper", writable: true },
        { name: "positionSusdeAta", writable: true },
        { name: "positionWsxmrAta", writable: true },
        { name: "vaultCollateralAta", writable: true },
        { name: "userWsxmrAta", writable: true },
        { name: "collateralMint" },
        { name: "wsxmrMint" },
        { name: "tokenProgram" },
        { name: "systemProgram" },
      ],
      args: [
        { name: "newRangeBps", type: "u16" },
      ]
    },
    {
      name: "triggerBuyAndBurn",
      discriminator: [250,148,86,91,91,255,171,8],
      accounts: [
        { name: "keeper", writable: true, signer: true },
        { name: "globalState", writable: true },
        { name: "wsxmrMint", writable: true },
        { name: "burnWsxmrAta", writable: true },
        { name: "keeperPendingReturns", writable: true },
        { name: "pythXmr" },
        { name: "pythCollateral" },
        { name: "tokenProgram" },
        { name: "systemProgram" },
      ],
      args: [
        { name: "wsxmrBought", type: "u64" },
      ]
    },
    {
      name: "continueDebtWipe",
      discriminator: [57,167,244,99,27,14,161,101],
      accounts: [
        { name: "globalState", writable: true },
      ],
      args: [
        { name: "batchSize", type: "u64" },
      ]
    },
    {
      name: "continueDebtMigration",
      discriminator: [114,1,129,80,130,189,196,64],
      accounts: [
        { name: "globalState", writable: true },
      ],
      args: [
        { name: "batchSize", type: "u64" },
      ]
    },
    {
      name: "initializePendingReturns",
      discriminator: [77,175,235,181,231,87,166,117],
      accounts: [
        { name: "owner", writable: true, signer: true },
        { name: "pendingReturns", writable: true },
        { name: "systemProgram" },
      ],
      args: []
    },
    {
      name: "withdrawCollateralReturns",
      discriminator: [97,12,150,237,16,150,252,254],
      accounts: [
        { name: "owner", signer: true },
        { name: "pendingReturns", writable: true },
        { name: "globalState", writable: true },
        { name: "collateralMint" },
        { name: "programCollateralAta", writable: true },
        { name: "userCollateralAta", writable: true },
        { name: "tokenProgram" },
      ],
      args: []
    },
    {
      name: "withdrawSolReturns",
      discriminator: [164,179,69,189,226,88,188,16],
      accounts: [
        { name: "owner", writable: true, signer: true },
        { name: "pendingReturns", writable: true },
        { name: "globalState", writable: true },
        { name: "solEscrow", writable: true },
        { name: "systemProgram" },
      ],
      args: []
    },
    {
      name: "reconcileGlobalDebt",
      discriminator: [217,34,41,18,221,74,151,218],
      accounts: [
        { name: "authority", signer: true },
        { name: "globalState", writable: true },
      ],
      args: []
    },
  ],
  accounts: [
    { name: "globalState",   discriminator: [163,46,74,168,216,123,133,98], size: 4400 },
    { name: "vault",         discriminator: [211,8,232,43,2,152,117,119], size: 1216 },
    { name: "mintRequest",   discriminator: [60,88,16,213,180,138,14,225], size: 512 },
    { name: "burnRequest",   discriminator: [192,96,174,201,165,92,135,80], size: 512 },
    { name: "pendingReturns",discriminator: [224,157,179,244,202,0,220,20], size: 64 },
    { name: "coLpPosition",  discriminator: [107,75,56,133,93,159,197,5], size: 168 },
  ],
  types: [
    {
      name: "globalState",
      type: {
        kind: "struct",
        fields: [
          { name: "authority",              type: "pubkey" },
          { name: "wsxmrMint",              type: "pubkey" },
          { name: "collateralMint",         type: "pubkey" },
          { name: "liquidityRouter",        type: "pubkey" },
          { name: "pythXmrFeed",            type: "pubkey" },
          { name: "globalTotalDebt",        type: "u64" },
          { name: "globalDebtIndex",        type: "u64" },
          { name: "yieldWarChest",          type: "u64" },
          { name: "globalLpPrincipal",      type: "u64" },
          { name: "globalLpPrincipalShares",type: "u64" },
          { name: "globalLpPrincipalValue", type: "u64" },
          { name: "globalPendingCollateral",type: "u64" },
          { name: "globalPendingSol",       type: "u64" },
          { name: "globalBadDebt",          type: "u64" },
          { name: "globalPendingBurnDebt",  type: "u64" },
          { name: "lastBuyTimestamp",       type: "i64" },
          { name: "debtWipeBatchStart",     type: "u64" },
          { name: "migrationBatchStart",    type: "u64" },
          { name: "migrationOldIndex",      type: "u64" },
          { name: "requestNonce",           type: "u64" },
          { name: "vaultCount",             type: "u32" },
          { name: "totalPendingMints",      type: "u32" },
          { name: "vaultList",              type: { array: ["pubkey", 128] } },
          { name: "bump",                   type: "u8" },
          { name: "reserved",               type: { array: ["u8", 7] } },
        ],
      },
    },
    {
      name: "vault",
      type: {
        kind: "struct",
        fields: [
          { name: "lpAddress",            type: "pubkey" },
          { name: "collateralAmount",     type: "u64" },
          { name: "lockedCollateral",     type: "u64" },
          { name: "normalizedDebt",       type: "u64" },
          { name: "pendingDebt",          type: "u64" },
          { name: "maxMintBps",           type: "u16" },
          { name: "mintGriefingDeposit",  type: "u64" },
          { name: "mintFeeBps",           type: "u16" },
          { name: "burnRewardBps",        type: "u16" },
          { name: "liquidationNonce",     type: "u64" },
          { name: "mintNonce",            type: "u64" },
          { name: "minBurnAmount",        type: "u64" },
          { name: "principalDeposits",    type: "u64" },
          { name: "principalShares",      type: "u64" },
          { name: "principalValue",       type: "u64" },
          { name: "activeBurnCount",      type: "u32" },
          { name: "pendingMintCount",     type: "u32" },
          { name: "mintTimeoutSeconds",   type: "i64" },
          { name: "burnTimeoutSeconds",   type: "i64" },
          { name: "whitelistedMinters",   type: { array: ["pubkey", 32] } },
          { name: "whitelistedMinterCount",type: "u32" },
          { name: "deployedCollateral",   type: "u64" },
          { name: "maxCoLPRangeBps",      type: "u16" },
          { name: "active",               type: "bool" },
          { name: "bump",                 type: "u8" },
        ],
      },
    },
    {
      name: "mintRequest",
      type: {
        kind: "struct",
        fields: [
          { name: "requestId",            type: { array: ["u8", 32] } },
          { name: "initiator",            type: "pubkey" },
          { name: "recipient",            type: "pubkey" },
          { name: "lpVault",              type: "pubkey" },
          { name: "xmrAmount",            type: "u64" },
          { name: "wsxmrAmount",          type: "u64" },
          { name: "feeAmount",            type: "u64" },
          { name: "claimCommitment",      type: { array: ["u8", 32] } },
          { name: "userPublicKey",        type: { array: ["u8", 32] } },
          { name: "lpPublicSpendKey",     type: { array: ["u8", 32] } },
          { name: "lpPublicViewKey",      type: { array: ["u8", 32] } },
          { name: "lpCommitment",         type: { array: ["u8", 32] } },
          { name: "timeout",              type: "i64" },
          { name: "griefingDeposit",      type: "u64" },
          { name: "lockedCollateral",     type: "u64" },
          { name: "xmrPriceAtReady",      type: "u64" },
          { name: "normalizedDebtAmount", type: "u64" },
          { name: "vaultMintNonce",       type: "u64" },
          { name: "revealedSecret",       type: { array: ["u8", 32] } },
          { name: "status",               type: { defined: { name: "MintStatus" } } },
          { name: "bump",                 type: "u8" },
        ],
      },
    },
    {
      name: "burnRequest",
      type: {
        kind: "struct",
        fields: [
          { name: "requestId",             type: { array: ["u8", 32] } },
          { name: "user",                  type: "pubkey" },
          { name: "lpVault",               type: "pubkey" },
          { name: "wsxmrAmount",           type: "u64" },
          { name: "xmrAmount",             type: "u64" },
          { name: "lockedCollateral",      type: "u64" },
          { name: "rewardCollateral",      type: "u64" },
          { name: "userClaimCommitment",   type: { array: ["u8", 32] } },
          { name: "userPublicKey",         type: { array: ["u8", 32] } },
          { name: "userViewKey",           type: { array: ["u8", 32] } },
          { name: "xmrPriceAtRequest",     type: "u64" },
          { name: "secretHash",            type: { array: ["u8", 32] } },
          { name: "lpPublicSpendKey",      type: { array: ["u8", 32] } },
          { name: "lpPublicViewKey",       type: { array: ["u8", 32] } },
          { name: "revealedSecret",        type: { array: ["u8", 32] } },
          { name: "deadline",              type: "i64" },
          { name: "vaultLiquidationNonce", type: "u64" },
          { name: "normalizedDebtAmount",  type: "u64" },
          { name: "abandoned",             type: "bool" },
          { name: "status",                type: { defined: { name: "BurnStatus" } } },
          { name: "bump",                  type: "u8" },
        ],
      },
    },
    {
      name: "pendingReturns",
      type: {
        kind: "struct",
        fields: [
          { name: "owner",            type: "pubkey" },
          { name: "collateralAmount", type: "u64" },
          { name: "solAmount",        type: "u64" },
          { name: "bump",             type: "u8" },
        ],
      },
    },
    {
      name: "coLpPosition",
      type: {
        kind: "struct",
        fields: [
          { name: "vault",             type: "pubkey" },
          { name: "user",              type: "pubkey" },
          { name: "collateralOriginal",type: "u64" },
          { name: "wsxmrOriginal",     type: "u64" },
          { name: "tickLower",         type: "i32" },
          { name: "tickUpper",         type: "i32" },
          { name: "liquidity",         type: "u128" },
          { name: "positionAddress",   type: "pubkey" },
          { name: "createdAt",         type: "i64" },
          { name: "nonce",             type: "u64" },
          { name: "bump",              type: "u8" },
        ],
      },
    },
    {
      name: "MintStatus",
      type: {
        kind: "enum",
        variants: [
          { name: "Invalid" }, { name: "Pending" }, { name: "KeyProvided" },
          { name: "Ready" }, { name: "SecretRevealed" }, { name: "Completed" },
          { name: "Cancelled" }, { name: "KeyCancelled" }, { name: "ExpiredReady" },
        ],
      },
    },
    {
      name: "BurnStatus",
      type: {
        kind: "enum",
        variants: [
          { name: "Invalid" }, { name: "Requested" }, { name: "Proposed" },
          { name: "Committed" }, { name: "Completed" }, { name: "Slashed" },
          { name: "Cancelled" },
        ],
      },
    },
  ],
  errors: [
    { code: 6000, name: "Unauthorized",           msg: "Unauthorized" },
    { code: 6001, name: "VaultNotActive",          msg: "Vault not active" },
    { code: 6002, name: "InsufficientCollateral",  msg: "Insufficient collateral" },
    { code: 6003, name: "ZeroAmount",              msg: "Zero amount" },
    { code: 6004, name: "MathOverflow",            msg: "Math overflow" },
    { code: 6005, name: "StalePrice",              msg: "Stale oracle price" },
    { code: 6006, name: "WarChestEmpty",           msg: "War chest empty" },
    { code: 6007, name: "CooldownActive",          msg: "Cooldown active" },
    { code: 6008, name: "XMRNotDipped",            msg: "XMR price not dipped below EMA threshold" },
    { code: 6009, name: "InvalidValue",            msg: "Invalid value" },
    { code: 6010, name: "VaultDoesNotExist",       msg: "Vault does not exist" },
    { code: 6011, name: "InvalidMintRequest",      msg: "Invalid mint request" },
    { code: 6012, name: "BelowMinimumBurn",        msg: "Below minimum burn amount" },
    { code: 6013, name: "OnlyRouter",              msg: "Only router" },
    { code: 6014, name: "OnlyDeployer",            msg: "Only deployer" },
    { code: 6015, name: "RouterAlreadySet",        msg: "Router already set" },
    { code: 6016, name: "ZeroAddress",             msg: "Zero address" },
    { code: 6017, name: "PriceNormalizedToZero",   msg: "Price normalized to zero" },
    { code: 6018, name: "XmrAmountTooSmall",       msg: "XMR amount too small" },
  ],
};
