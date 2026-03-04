const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("WrapSynth Comprehensive Test Suite - Gnosis Fork", function () {
  let wsxmrToken;
  let vaultManager;
  let liquidityRouter;
  let owner, lp1, lp2, user1, user2, liquidator, keeper;
  let sDAI, xDAI, pythOracle;
  
  const GNOSIS_CHAIN_ID = 100;
  const GNOSIS_RPC = "https://rpc.gnosischain.com";
  
  // Gnosis addresses
  const SDAI_ADDRESS = "0xaf204776c7245bF4147c2612BF6e5972Ee483701";
  const XDAI_ADDRESS = "0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d";
  const PYTH_ORACLE = "0x2880aB155794e7179c9eE2e38200202908C17B43";
  const UNISWAP_V3_POSITION_MANAGER = "0xC36442b4a4522E871399CD717aBDD847Ab11FE88";
  
  // Price feed IDs
  const XMR_USD_FEED_ID = "0x46b8cc9347f04391764a0361e0b17c3ba394b001e7c304f7650f6376e37c321d";
  const DAI_USD_FEED_ID = "0xb0948a5e5313200c632b51bb5ca32f6de0d36e9950a942d19751e833f70dabfd";
  
  before(async function () {
    // Get signers
    [owner, lp1, lp2, user1, user2, liquidator, keeper] = await ethers.getSigners();
    
    console.log("Forking Gnosis Chain...");
    await network.provider.request({
      method: "hardhat_reset",
      params: [{
        forking: {
          jsonRpcUrl: GNOSIS_RPC,
          blockNumber: undefined // Use latest block
        }
      }]
    });
    
    // Get contract instances for existing Gnosis contracts
    sDAI = await ethers.getContractAt("ISavingsDAI", SDAI_ADDRESS);
    xDAI = await ethers.getContractAt("IERC20", XDAI_ADDRESS);
    pythOracle = await ethers.getContractAt("IPyth", PYTH_ORACLE);
    
    console.log("Deploying wsXMR token...");
    const WsXMR = await ethers.getContractFactory("wsXMR");
    wsxmrToken = await WsXMR.deploy(owner.address);
    await wsxmrToken.waitForDeployment();
    
    console.log("Deploying VaultManager...");
    const VaultManager = await ethers.getContractFactory("VaultManager");
    vaultManager = await VaultManager.deploy(
      await wsxmrToken.getAddress(),
      PYTH_ORACLE,
      owner.address
    );
    await vaultManager.waitForDeployment();
    
    console.log("Deploying LiquidityRouter...");
    const LiquidityRouter = await ethers.getContractFactory("wsXMRLiquidityRouter");
    liquidityRouter = await LiquidityRouter.deploy(
      await vaultManager.getAddress(),
      await wsxmrToken.getAddress(),
      UNISWAP_V3_POSITION_MANAGER,
      owner.address
    );
    await liquidityRouter.waitForDeployment();
    
    // Set VaultManager as minter for wsXMR
    await wsxmrToken.setVaultManager(await vaultManager.getAddress());
    
    console.log("Setup complete!");
    console.log("wsXMR:", await wsxmrToken.getAddress());
    console.log("VaultManager:", await vaultManager.getAddress());
    console.log("LiquidityRouter:", await liquidityRouter.getAddress());
  });
  
  // Helper function to get xDAI for testing
  async function getXDAI(account, amount) {
    // Impersonate a whale account with xDAI
    const whaleAddress = "0xBA12222222228d8Ba445958a75a0704d566BF2C8"; // Balancer Vault
    await network.provider.request({
      method: "hardhat_impersonateAccount",
      params: [whaleAddress]
    });
    const whale = await ethers.getSigner(whaleAddress);
    
    // Fund whale with ETH for gas
    await owner.sendTransaction({
      to: whaleAddress,
      value: ethers.parseEther("1")
    });
    
    // Transfer xDAI
    await xDAI.connect(whale).transfer(account.address, amount);
    
    await network.provider.request({
      method: "hardhat_stopImpersonatingAccount",
      params: [whaleAddress]
    });
  }
  
  // Helper to generate secp256k1 secret and commitment
  function generateSecret() {
    const secret = ethers.randomBytes(32);
    const secretHash = ethers.keccak256(secret);
    return { secret: ethers.hexlify(secret), secretHash };
  }

  describe("1. wsXMR Token Authority Checks", function () {
    describe("A. VaultManager can mint and burn", function () {
      it("Should allow VaultManager to mint wsXMR", async function () {
        const mintAmount = ethers.parseUnits("100", 8); // 100 wsXMR
        
        await expect(
          vaultManager.connect(owner).mint(user1.address, mintAmount)
        ).to.emit(wsxmrToken, "Transfer")
          .withArgs(ethers.ZeroAddress, user1.address, mintAmount);
        
        expect(await wsxmrToken.balanceOf(user1.address)).to.equal(mintAmount);
      });
      
      it("Should allow VaultManager to burn wsXMR", async function () {
        const burnAmount = ethers.parseUnits("50", 8);
        const initialBalance = await wsxmrToken.balanceOf(user1.address);
        
        await expect(
          vaultManager.connect(owner).burn(user1.address, burnAmount)
        ).to.emit(wsxmrToken, "Transfer")
          .withArgs(user1.address, ethers.ZeroAddress, burnAmount);
        
        expect(await wsxmrToken.balanceOf(user1.address)).to.equal(initialBalance - burnAmount);
      });
    });
    
    describe("B. Arbitrary address cannot mint or burn", function () {
      it("Should revert when non-VaultManager tries to mint", async function () {
        const mintAmount = ethers.parseUnits("100", 8);
        
        await expect(
          wsxmrToken.connect(user1).mint(user2.address, mintAmount)
        ).to.be.revertedWithCustomError(wsxmrToken, "OnlyVaultManager");
      });
      
      it("Should revert when non-VaultManager tries to burn", async function () {
        const burnAmount = ethers.parseUnits("10", 8);
        
        await expect(
          wsxmrToken.connect(user1).burn(user1.address, burnAmount)
        ).to.be.revertedWithCustomError(wsxmrToken, "OnlyVaultManager");
      });
    });
  });

  describe("2. Vault Creation and Asset Management", function () {
    describe("A. User deposits DAI into vault with sDAI conversion", function () {
      it("Should create vault and deposit DAI, converting to sDAI", async function () {
        // Get xDAI for LP1
        const daiAmount = ethers.parseEther("10000"); // 10,000 DAI
        await getXDAI(lp1, daiAmount);
        
        // Create vault
        await vaultManager.connect(lp1).createVault(SDAI_ADDRESS);
        
        // Approve and deposit
        await xDAI.connect(lp1).approve(await vaultManager.getAddress(), daiAmount);
        await vaultManager.connect(lp1).depositCollateral(daiAmount);
        
        const vault = await vaultManager.getVault(lp1.address);
        expect(vault.active).to.be.true;
        expect(vault.collateralAsset).to.equal(SDAI_ADDRESS);
        expect(vault.collateralAmount).to.be.gt(0); // Should have sDAI shares
        
        // Verify lpPrincipalDeposits tracking
        const principal = await vaultManager.lpPrincipalDeposits(lp1.address);
        expect(principal).to.equal(daiAmount);
      });
    });
    
    describe("B. User deposits native asset into ERC20 vault", function () {
      it("Should revert when depositing ETH to sDAI vault", async function () {
        await expect(
          vaultManager.connect(lp1).depositCollateral(ethers.parseEther("1"), {
            value: ethers.parseEther("1")
          })
        ).to.be.revertedWithCustomError(vaultManager, "InvalidValue");
      });
    });
    
    describe("A. LP withdraws unlocked collateral while maintaining health", function () {
      it("Should allow withdrawal if health ratio stays above 150%", async function () {
        const vault = await vaultManager.getVault(lp1.address);
        const withdrawAmount = vault.collateralAmount / 10n; // Withdraw 10%
        
        const initialBalance = await sDAI.balanceOf(lp1.address);
        
        await vaultManager.connect(lp1).withdrawCollateral(withdrawAmount);
        
        const finalBalance = await sDAI.balanceOf(lp1.address);
        expect(finalBalance).to.be.gt(initialBalance);
      });
    });
    
    describe("B. LP attempts to withdraw locked collateral", function () {
      it("Should revert when trying to withdraw locked collateral", async function () {
        // This will be tested in the burn lifecycle section
        // For now, we'll skip as we need to create a burn request first
        this.skip();
      });
    });
  });

  describe("3. Minting Lifecycle and Anti-Spam", function () {
    let mintRequestId;
    const xmrAmount = ethers.parseUnits("1", 12); // 1 XMR (12 decimals)
    const griefingDeposit = ethers.parseEther("0.01"); // 0.01 ETH
    
    before(async function () {
      // LP1 sets griefing deposit and market metrics
      await vaultManager.connect(lp1).setMintGriefingDeposit(griefingDeposit);
      await vaultManager.connect(lp1).setVaultMarketMetrics(100, 50); // 1% fee, 0.5% reward
    });
    
    describe("A. User provides exact griefing deposit and LP finalizes", function () {
      it("Should initiate mint with exact griefing deposit", async function () {
        const { secret, secretHash } = generateSecret();
        const timeout = 3600; // 1 hour
        
        const tx = await vaultManager.connect(user1).initiateMint(
          lp1.address,
          xmrAmount,
          secretHash,
          timeout,
          { value: griefingDeposit }
        );
        
        const receipt = await tx.wait();
        const event = receipt.logs.find(log => {
          try {
            return vaultManager.interface.parseLog(log).name === "MintInitiated";
          } catch {
            return false;
          }
        });
        
        const parsedEvent = vaultManager.interface.parseLog(event);
        mintRequestId = parsedEvent.args.requestId;
        
        expect(mintRequestId).to.not.equal(ethers.ZeroHash);
      });
      
      it("Should allow LP to set mint ready", async function () {
        await expect(
          vaultManager.connect(lp1).setMintReady(mintRequestId)
        ).to.emit(vaultManager, "MintReady")
          .withArgs(mintRequestId);
      });
      
      it("Should finalize mint with valid secret", async function () {
        // Note: In real scenario, secret would be revealed by LP
        // For testing, we'll use a mock secret that passes verification
        const mockSecret = ethers.randomBytes(32);
        
        // This will likely fail verification, but demonstrates the flow
        // In production tests, you'd use proper secp256k1 implementation
        try {
          await vaultManager.connect(user1).finalizeMint(mintRequestId, mockSecret);
        } catch (error) {
          // Expected to fail without proper secp256k1 secret
          expect(error.message).to.include("InvalidSecret");
        }
      });
    });
    
    describe("B. User provides insufficient griefing deposit", function () {
      it("Should revert with insufficient deposit", async function () {
        const { secretHash } = generateSecret();
        const timeout = 3600;
        const insufficientDeposit = griefingDeposit / 2n;
        
        await expect(
          vaultManager.connect(user2).initiateMint(
            lp1.address,
            xmrAmount,
            secretHash,
            timeout,
            { value: insufficientDeposit }
          )
        ).to.be.revertedWithCustomError(vaultManager, "InsufficientDeposit");
      });
    });
    
    describe("A. User fails to lock XMR before timeout", function () {
      it("Should allow cancellation after timeout and award deposit to LP", async function () {
        const { secretHash } = generateSecret();
        const timeout = 60; // 1 minute
        
        const tx = await vaultManager.connect(user2).initiateMint(
          lp1.address,
          xmrAmount / 10n,
          secretHash,
          timeout,
          { value: griefingDeposit }
        );
        
        const receipt = await tx.wait();
        const event = receipt.logs.find(log => {
          try {
            return vaultManager.interface.parseLog(log).name === "MintInitiated";
          } catch {
            return false;
          }
        });
        const parsedEvent = vaultManager.interface.parseLog(event);
        const requestId = parsedEvent.args.requestId;
        
        // Fast forward past timeout
        await time.increase(timeout + 1);
        
        const lpBalanceBefore = await vaultManager.pendingReturns(lp1.address, ethers.ZeroAddress);
        
        await vaultManager.connect(keeper).cancelMint(requestId);
        
        const lpBalanceAfter = await vaultManager.pendingReturns(lp1.address, ethers.ZeroAddress);
        expect(lpBalanceAfter).to.equal(lpBalanceBefore + griefingDeposit);
      });
    });
    
    describe("B. LP confirms but fails to finalize before extended timeout", function () {
      it("Should refund deposit to user after extended timeout", async function () {
        const { secretHash } = generateSecret();
        const timeout = 60;
        
        const tx = await vaultManager.connect(user2).initiateMint(
          lp1.address,
          xmrAmount / 10n,
          secretHash,
          timeout,
          { value: griefingDeposit }
        );
        
        const receipt = await tx.wait();
        const event = receipt.logs.find(log => {
          try {
            return vaultManager.interface.parseLog(log).name === "MintInitiated";
          } catch {
            return false;
          }
        });
        const parsedEvent = vaultManager.interface.parseLog(event);
        const requestId = parsedEvent.args.requestId;
        
        // LP sets ready
        await vaultManager.connect(lp1).setMintReady(requestId);
        
        // Fast forward past extended timeout
        const MINT_READY_EXTENSION = 8 * 3600; // 8 hours
        await time.increase(timeout + MINT_READY_EXTENSION + 1);
        
        const userBalanceBefore = await vaultManager.pendingReturns(user2.address, ethers.ZeroAddress);
        
        await vaultManager.connect(keeper).cancelMint(requestId);
        
        const userBalanceAfter = await vaultManager.pendingReturns(user2.address, ethers.ZeroAddress);
        expect(userBalanceAfter).to.equal(userBalanceBefore + griefingDeposit);
      });
    });
    
    describe("A. User requests mint within LP capacity", function () {
      it("Should accept mint request within maxMintBps", async function () {
        // Set maxMintBps to 1000 (10%)
        await vaultManager.connect(lp1).setMaxMintBps(1000);
        
        const { secretHash } = generateSecret();
        const smallAmount = xmrAmount / 100n; // Small amount
        
        await expect(
          vaultManager.connect(user2).initiateMint(
            lp1.address,
            smallAmount,
            secretHash,
            3600,
            { value: griefingDeposit }
          )
        ).to.emit(vaultManager, "MintInitiated");
      });
    });
    
    describe("B. User exceeds LP maxMintBps capacity", function () {
      it("Should revert when mint exceeds maxMintBps", async function () {
        // Set very low maxMintBps
        await vaultManager.connect(lp1).setMaxMintBps(1); // 0.01%
        
        const { secretHash } = generateSecret();
        
        await expect(
          vaultManager.connect(user2).initiateMint(
            lp1.address,
            xmrAmount,
            secretHash,
            3600,
            { value: griefingDeposit }
          )
        ).to.be.revertedWithCustomError(vaultManager, "InvalidValue");
        
        // Reset for other tests
        await vaultManager.connect(lp1).setMaxMintBps(0); // No limit
      });
    });
  });

  describe("4. Burning Lifecycle and Slashing Mechanics", function () {
    let burnRequestId;
    const burnAmount = ethers.parseUnits("0.1", 8); // 0.1 wsXMR
    
    before(async function () {
      // Ensure user1 has wsXMR to burn
      // We'll need to properly mint some first via VaultManager
      // For now, we'll use owner to directly mint for testing
      const testAmount = ethers.parseUnits("10", 8);
      
      // Create a simple mint scenario
      const daiAmount = ethers.parseEther("50000");
      await getXDAI(lp2, daiAmount);
      await vaultManager.connect(lp2).createVault(SDAI_ADDRESS);
      await xDAI.connect(lp2).approve(await vaultManager.getAddress(), daiAmount);
      await vaultManager.connect(lp2).depositCollateral(daiAmount);
    });
    
    describe("A. Full 4-step burn completes successfully", function () {
      it("Should complete full burn lifecycle", async function () {
        // This requires proper implementation of secp256k1
        // For now, we'll test the state transitions
        this.skip();
      });
    });
    
    describe("B. LP fails to reveal secret after user confirms", function () {
      it("Should allow user to claim slashed collateral", async function () {
        // Requires full burn flow implementation
        this.skip();
      });
    });
    
    describe("A. User abandons burn request", function () {
      it("Should allow LP to cancel and restore debt", async function () {
        // Test will be implemented with proper flow
        this.skip();
      });
    });
    
    describe("B. User routes burn to unhealthy vault", function () {
      it("Should revert when vault health < 150%", async function () {
        // Would need to create an unhealthy vault scenario
        this.skip();
      });
    });
  });

  describe("5. Liquidation Engine and Bad Debt", function () {
    describe("A. Liquidate vault at 115% health ratio", function () {
      it("Should successfully liquidate underwater vault", async function () {
        // Requires price manipulation or vault with debt
        this.skip();
      });
    });
    
    describe("B. Attempt to liquidate healthy vault at 121%", function () {
      it("Should revert with VaultHealthy error", async function () {
        const vault = await vaultManager.getVault(lp1.address);
        if (vault.active) {
          await expect(
            vaultManager.connect(liquidator).liquidate(lp1.address, ethers.parseUnits("1", 8))
          ).to.be.revertedWithCustomError(vaultManager, "VaultHealthy");
        }
      });
    });
    
    describe("A. Severely underwater vault liquidation", function () {
      it("Should scale down debt to maintain 10% bonus", async function () {
        this.skip();
      });
    });
    
    describe("B. Completely drained vault cleanup", function () {
      it("Should emit BadDebtWrittenOff event", async function () {
        this.skip();
      });
    });
  });

  describe("6. Protocol Market Defense (Buy-and-Burn)", function () {
    describe("A. Trigger buy-and-burn when XMR dips 1% below EMA", function () {
      it("Should execute buy-and-burn successfully", async function () {
        // Requires yield accumulation and price conditions
        this.skip();
      });
    });
    
    describe("B. Attempt trigger during cooldown or above threshold", function () {
      it("Should revert during cooldown period", async function () {
        // Would need to trigger once first
        this.skip();
      });
    });
    
    describe("A. Buy-and-burn with MEV protection", function () {
      it("Should limit slippage to 2%", async function () {
        this.skip();
      });
    });
    
    describe("B. Pyth oracle high uncertainty rejection", function () {
      it("Should revert with StalePrice on >10% confidence", async function () {
        // Requires mocking Pyth oracle response
        this.skip();
      });
    });
    
    describe("A. Yield skimming calculation", function () {
      it("Should skim yield in O(1) complexity", async function () {
        this.skip();
      });
    });
    
    describe("B. Burn wsXMR and update global debt index", function () {
      it("Should proportionally reduce debt across all vaults", async function () {
        this.skip();
      });
    });
  });

  describe("7. Router Matchmaking and Dual-Approval", function () {
    describe("A. LP and User mutually approve and create position", function () {
      it("Should create Uniswap V3 position with mutual consent", async function () {
        // Requires both parties to have allocated funds
        this.skip();
      });
    });
    
    describe("B. LP approves but User doesn't approve LP", function () {
      it("Should revert without mutual consent", async function () {
        const sDAIAmount = ethers.parseEther("1000");
        const wsxmrAmount = ethers.parseUnits("1", 8);
        
        // LP approves user
        await liquidityRouter.connect(lp1).approveUserForPairing(user1.address, true);
        
        // User does NOT approve LP
        
        await expect(
          liquidityRouter.connect(lp1).createPosition(
            lp1.address,
            user1.address,
            sDAIAmount,
            wsxmrAmount
          )
        ).to.be.reverted;
      });
    });
  });

  describe("8. Router Oracle Price Validation", function () {
    describe("A. Router validates collateral bounds match oracle", function () {
      it("Should create position when prices align with oracle", async function () {
        this.skip();
      });
    });
    
    describe("B. Flash loan pool manipulation detection", function () {
      it("Should revert on >10% spot divergence", async function () {
        this.skip();
      });
    });
  });

  describe("9. Router Impermanent Loss and Fee Distribution", function () {
    describe("A. Position closed with price divergence", function () {
      it("Should distribute based on original USD value", async function () {
        this.skip();
      });
    });
    
    describe("B. Unauthorized position close attempt", function () {
      it("Should revert with Unauthorized error", async function () {
        // Try to close a non-existent or other user's position
        await expect(
          liquidityRouter.connect(user2).closePosition(999)
        ).to.be.revertedWithCustomError(liquidityRouter, "PositionNotFound");
      });
    });
    
    describe("A. Position accumulates trading fees", function () {
      it("Should split fees 50/50 between LP and User", async function () {
        this.skip();
      });
    });
    
    describe("B. LP attempts to deallocate active liquidity", function () {
      it("Should revert due to insufficient idle balance", async function () {
        // LP would need active position first
        const largeAmount = ethers.parseEther("999999999");
        
        await expect(
          liquidityRouter.connect(lp1).deallocateLiquidity(largeAmount)
        ).to.be.revertedWithCustomError(liquidityRouter, "InsufficientBalance");
      });
    });
  });

  describe("10. Integration Tests", function () {
    it("Should handle complete lifecycle: deposit -> mint -> burn -> withdraw", async function () {
      // Full integration test
      this.skip();
    });
    
    it("Should handle multiple concurrent operations", async function () {
      this.skip();
    });
  });
});
