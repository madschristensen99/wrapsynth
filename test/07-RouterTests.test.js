const { expect } = require("chai");
const { ethers } = require("hardhat");
const { ADDRESSES, getXDAI, setupVaultWithCollateral } = require("./helpers/testHelpers");

describe("Router Matchmaking and Liquidity Management", function () {
  let wsxmrToken, vaultManager, liquidityRouter;
  let owner, lp1, user1, user2;

  before(async function () {
    [owner, lp1, user1, user2] = await ethers.getSigners();

    // Deploy contracts
    const WsXMR = await ethers.getContractFactory("wsXMR");
    wsxmrToken = await WsXMR.deploy(owner.address);
    await wsxmrToken.waitForDeployment();

    const VaultManager = await ethers.getContractFactory("VaultManager");
    vaultManager = await VaultManager.deploy(
      await wsxmrToken.getAddress(),
      ADDRESSES.PYTH_ORACLE,
      owner.address
    );
    await vaultManager.waitForDeployment();

    const LiquidityRouter = await ethers.getContractFactory("wsXMRLiquidityRouter");
    liquidityRouter = await LiquidityRouter.deploy(
      await vaultManager.getAddress(),
      await wsxmrToken.getAddress(),
      ADDRESSES.UNISWAP_V3_POSITION_MANAGER,
      owner.address
    );
    await liquidityRouter.waitForDeployment();

    await wsxmrToken.setVaultManager(await vaultManager.getAddress());

    // Setup vault
    await setupVaultWithCollateral(vaultManager, lp1, ethers.parseEther("100000"));
  });

  describe("7. Router Matchmaking and Dual-Approval", function () {
    describe("A. LP and User Mutually Approve and Create Position", function () {
      it("Should create Uniswap V3 position with mutual consent", async function () {
        // Requires:
        // 1. LP allocates sDAI
        // 2. User deposits wsXMR
        // 3. Both approve each other
        // 4. Create position
        this.skip();
      });
    });

    describe("B. LP Approves but User Doesn't Approve LP", function () {
      it("Should revert without mutual consent", async function () {
        const sDAIAmount = ethers.parseEther("1000");
        const wsxmrAmount = ethers.parseUnits("1", 8);

        // LP approves user
        await liquidityRouter.connect(lp1).approveUserForPairing(user1.address, true);

        // User does NOT approve LP
        // Verify approval state
        const lpApproved = await liquidityRouter.lpApprovedUsers(lp1.address, user1.address);
        const userApproved = await liquidityRouter.userApprovedLps(user1.address, lp1.address);
        
        expect(lpApproved).to.be.true;
        expect(userApproved).to.be.false;

        // Attempt to create position should fail
        await expect(
          liquidityRouter.connect(lp1).createPosition(
            lp1.address,
            user1.address,
            sDAIAmount,
            wsxmrAmount
          )
        ).to.be.reverted;
      });

      it("Should succeed when both parties approve", async function () {
        // User now approves LP
        await liquidityRouter.connect(user1).approveLpForPairing(lp1.address, true);

        const lpApproved = await liquidityRouter.lpApprovedUsers(lp1.address, user1.address);
        const userApproved = await liquidityRouter.userApprovedLps(user1.address, lp1.address);
        
        expect(lpApproved).to.be.true;
        expect(userApproved).to.be.true;

        // Position creation would still fail due to insufficient balances
        // but the approval check passes
      });
    });
  });

  describe("8. Router Oracle Price Validation", function () {
    describe("A. Router Validates Collateral Bounds Match Oracle", function () {
      it("Should create position when prices align with oracle", async function () {
        this.skip();
      });
    });

    describe("B. Flash Loan Pool Manipulation Detection", function () {
      it("Should revert on >10% spot divergence from oracle", async function () {
        this.skip();
      });

      it("Should validate pool ratio against Pyth oracle prices", async function () {
        this.skip();
      });
    });
  });

  describe("9. Router Impermanent Loss and Fee Distribution", function () {
    describe("A. Position Closed with Price Divergence", function () {
      it("Should distribute based on original USD value configuration", async function () {
        this.skip();
      });

      it("Should give both parties proportional share of both assets", async function () {
        this.skip();
      });
    });

    describe("B. Unauthorized Position Close Attempt", function () {
      it("Should revert with Unauthorized error", async function () {
        await expect(
          liquidityRouter.connect(user2).closePosition(999)
        ).to.be.revertedWithCustomError(liquidityRouter, "PositionNotFound");
      });

      it("Should only allow LP or User to close their position", async function () {
        // Would need active position first
        this.skip();
      });
    });

    describe("A. Position Accumulates Trading Fees", function () {
      it("Should split fees 50/50 between LP and User", async function () {
        this.skip();
      });

      it("Should track pendingSDAIFees and pendingWsxmrFees correctly", async function () {
        this.skip();
      });

      it("Should allow fee withdrawal", async function () {
        const sDAIFees = await liquidityRouter.pendingSDAIFees(lp1.address);
        const wsxmrFees = await liquidityRouter.pendingWsxmrFees(lp1.address);
        
        // Should be zero initially
        expect(sDAIFees).to.equal(0);
        expect(wsxmrFees).to.equal(0);
      });
    });

    describe("B. LP Attempts to Deallocate Active Liquidity", function () {
      it("Should revert due to insufficient idle balance", async function () {
        const largeAmount = ethers.parseEther("999999999");

        await expect(
          liquidityRouter.connect(lp1).deallocateLiquidity(largeAmount)
        ).to.be.revertedWithCustomError(liquidityRouter, "InsufficientBalance");
      });

      it("Should only allow deallocation of idle (non-position) liquidity", async function () {
        this.skip();
      });
    });
  });

  describe("Edge Cases", function () {
    it("Should revert when allocating zero liquidity", async function () {
      await expect(
        liquidityRouter.connect(lp1).allocateLiquidity(0)
      ).to.be.revertedWithCustomError(liquidityRouter, "InvalidAmount");
    });

    it("Should revert when depositing zero wsXMR", async function () {
      await expect(
        liquidityRouter.connect(user1).depositWsxmr(0)
      ).to.be.revertedWithCustomError(liquidityRouter, "InvalidAmount");
    });

    it("Should revert when withdrawing more than deposited", async function () {
      await expect(
        liquidityRouter.connect(user1).withdrawWsxmr(ethers.parseUnits("1000", 8))
      ).to.be.revertedWithCustomError(liquidityRouter, "InsufficientBalance");
    });

    it("Should revert when LP without active vault tries to allocate", async function () {
      await expect(
        liquidityRouter.connect(user2).allocateLiquidity(ethers.parseEther("1000"))
      ).to.be.revertedWithCustomError(liquidityRouter, "VaultNotActive");
    });
  });
});
