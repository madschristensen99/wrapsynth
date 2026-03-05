import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { WsxmrSolana } from "../target/types/wsxmr_solana";
import { PublicKey, Keypair, SystemProgram } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, createMint, createAccount, mintTo } from "@solana/spl-token";
import { assert } from "chai";

describe("wsxmr_solana", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.WsxmrSolana as Program<WsxmrSolana>;
  
  let wsxmrMint: PublicKey;
  let collateralMint: PublicKey;
  let globalState: PublicKey;
  let mintAuthority: PublicKey;
  let vault: PublicKey;
  
  const admin = provider.wallet;
  const lp = Keypair.generate();
  const user = Keypair.generate();

  before(async () => {
    // Airdrop SOL to test accounts
    const airdropLp = await provider.connection.requestAirdrop(
      lp.publicKey,
      2 * anchor.web3.LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(airdropLp);

    const airdropUser = await provider.connection.requestAirdrop(
      user.publicKey,
      2 * anchor.web3.LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(airdropUser);
  });

  it("Initializes global state", async () => {
    [globalState] = PublicKey.findProgramAddressSync(
      [Buffer.from("global_state")],
      program.programId
    );

    [mintAuthority] = PublicKey.findProgramAddressSync(
      [Buffer.from("mint_authority")],
      program.programId
    );

    wsxmrMint = await createMint(
      provider.connection,
      admin.payer,
      mintAuthority,
      null,
      8 // WSXMR_DECIMALS
    );

    const priceMaxAge = new anchor.BN(300); // 5 minutes

    await program.methods
      .initializeGlobal(priceMaxAge)
      .accounts({
        globalState,
        wsxmrMint,
        mintAuthority,
        admin: admin.publicKey,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .rpc();

    const globalStateAccount = await program.account.globalState.fetch(globalState);
    assert.equal(globalStateAccount.priceMaxAge.toNumber(), 300);
    assert.equal(globalStateAccount.wsxmrMint.toString(), wsxmrMint.toString());
  });

  it("Creates an LP vault", async () => {
    // Create collateral mint (simulating USDC or similar)
    collateralMint = await createMint(
      provider.connection,
      lp,
      lp.publicKey,
      null,
      6 // 6 decimals like USDC
    );

    [vault] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("vault"),
        lp.publicKey.toBuffer(),
        collateralMint.toBuffer(),
      ],
      program.programId
    );

    await program.methods
      .createVault(collateralMint)
      .accounts({
        vault,
        lp: lp.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([lp])
      .rpc();

    const vaultAccount = await program.account.vault.fetch(vault);
    assert.equal(vaultAccount.lpAddress.toString(), lp.publicKey.toString());
    assert.equal(vaultAccount.collateralMint.toString(), collateralMint.toString());
    assert.equal(vaultAccount.active, true);
  });

  it("Deposits collateral to vault", async () => {
    const lpCollateralAccount = await createAccount(
      provider.connection,
      lp,
      collateralMint,
      lp.publicKey
    );

    const vaultCollateralAccount = await createAccount(
      provider.connection,
      lp,
      collateralMint,
      vault,
      undefined,
      TOKEN_PROGRAM_ID
    );

    // Mint some collateral to LP
    const collateralAmount = 1000000000; // 1000 tokens with 6 decimals
    await mintTo(
      provider.connection,
      lp,
      collateralMint,
      lpCollateralAccount,
      lp.publicKey,
      collateralAmount
    );

    const depositAmount = new anchor.BN(500000000); // 500 tokens

    await program.methods
      .depositCollateral(depositAmount)
      .accounts({
        vault,
        globalState,
        lpCollateralAccount,
        vaultCollateralAccount,
        lp: lp.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([lp])
      .rpc();

    const vaultAccount = await program.account.vault.fetch(vault);
    assert.equal(vaultAccount.collateralAmount.toString(), depositAmount.toString());
  });

  it("Sets vault parameters", async () => {
    const mintFeeBps = 30; // 0.3%
    const burnRewardBps = 20; // 0.2%
    const maxMintBps = 5000; // 50%
    const mintGriefingDeposit = new anchor.BN(10000000); // 0.01 SOL
    const active = true;

    await program.methods
      .setVaultParams(
        mintFeeBps,
        burnRewardBps,
        maxMintBps,
        mintGriefingDeposit,
        active
      )
      .accounts({
        vault,
        lp: lp.publicKey,
      })
      .signers([lp])
      .rpc();

    const vaultAccount = await program.account.vault.fetch(vault);
    assert.equal(vaultAccount.mintFeeBps, mintFeeBps);
    assert.equal(vaultAccount.burnRewardBps, burnRewardBps);
    assert.equal(vaultAccount.maxMintBps, maxMintBps);
  });

  // Additional tests for mint/burn flows would go here
  // These would require mock Pyth oracles and more complex setup
});
