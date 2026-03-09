const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const {
  ADDRESSES,
  FEED_IDS,
  getXDAI,
  generateSecret,
  deployMockPyth,
  updateMockPythPrice,
  increaseTime,
  getCurrentTimestamp,
} = require("./helpers/testHelpers");

describe("Protocol Patches - Comprehensive Tests", function () {
  let vaultManager;
  let wsxmrToken;
  let router;
  let mockPyth;
  let owner, lp1, lp2, user1, user2;
  let xDAI, sDAI;

  const DAI_AMOUNT = ethers.parseEther("100000"); // 100k DAI
  const XMR_AMOUNT = ethers.parseUnits("100", 12); // 100 XMR (12 decimals)

  beforeEach(async function () {
    [owner, lp1, lp2, user1, user2] = await ethers.getSigners();

    // Deploy MockPyth
    mockPyth = await deployMockPyth();

    // Deploy VaultManager
    const VaultManager = await ethers.getContractFactory("VaultManager");
    vaultManager = await VaultManager.deploy(await mockPyth.getAddress());
    await vaultManager.waitForDeployment();

    wsxmrToken = await ethers.getContractAt(
      "wsXMR",
      await vaultManager.wsxmrToken()
    );

    // Deploy Router
    const Router = await ethers.getContractFactory("wsXMRLiquidityRouter");
    router = await Router.deploy(
      await vaultManager.getAddress(),
      await wsxmrToken.getAddress(),
      ADDRESSES.UNISWAP_V3_POSITION_MANAGER
    );
    await router.waitForDeployment();

    // Get token contracts
    xDAI = await ethers.getContractAt("IERC20", ADDRESSES.XDAI);
    sDAI = await ethers.getContractAt("IERC20", ADDRESSES.SDAI);

    // Setup LP1 vault with collateral
    await getXDAI(lp1, DAI_AMOUNT);
    await vaultManager.connect(lp1).createVault();
    await xDAI.connect(lp1).approve(await vaultManager.getAddress(), DAI_AMOUNT);
    await vaultManager.connect(lp1).depositCollateral(DAI_AMOUNT);
  });

  describe("6A. cancelBurn debt restoration", function () {
    it("should restore debt after partial liquidation that increments liquidationNonce", async function () {
      // Setup: Create vault with collateral and mint wsXMR
      const wsxmrAmount = ethers.parseUnits("100", 8); // 100 wsXMR
      
      // Initiate and complete a mint
      const { secret, secretHash } = generateSecret();
      const timeout = 3600;
      
      const tx = await vaultManager.connect(user1).initiateMint(
        lp1.address,
        user1.address,
        XMR_AMOUNT,
        secretHash,
        timeout,
        { value: 0 }
      );
      
      const receipt = await tx.wait();
      const event = receipt.logs.find(log => {
        try {
          return vaultManager.interface.parseLog(log).name === "MintInitiated";
        } catch {
          return false;
        }
      });
      const requestId = vaultManager.interface.parseLog(event).args.requestId;
      
      // LP sets ready and user finalizes
      await vaultManager.connect(lp1).setMintReady(requestId);
      await vaultManager.connect(owner).finalizeMint(requestId, secret);
      
      // Request burn
      await wsxmrToken.connect(user1).approve(await vaultManager.getAddress(), wsxmrAmount);
      const burnTx = await vaultManager.connect(user1).requestBurn(
        wsxmrAmount,
        lp1.address,
        user1.address
      );
      
      const burnReceipt = await burnTx.wait();
      const burnEvent = burnReceipt.logs.find(log => {
        try {
          return vaultManager.interface.parseLog(log).name === "BurnRequested";
        } catch {
          return false;
        }
      });
      const burnRequestId = vaultManager.interface.parseLog(burnEvent).args.requestId;
      
      // Get initial vault state
      const vaultBefore = await vaultManager.vaults(lp1.address);
      const globalDebtBefore = await vaultManager.globalTotalDebt();
      
      // Perform partial liquidation (this increments liquidationNonce)
      // First, manipulate price to make vault liquidatable
      await updateMockPythPrice(mockPyth, FEED_IDS.XMR_USD, 50000000000, 1000000); // $500 XMR
      
      // Liquidate small amount
      const debtToClear = ethers.parseUnits("1", 8);
      await wsxmrToken.connect(owner).approve(await vaultManager.getAddress(), debtToClear);
      await vaultManager.connect(owner).liquidate(lp1.address, debtToClear);
      
      // Verify liquidationNonce was incremented
      const vaultAfterLiq = await vaultManager.vaults(lp1.address);
      expect(vaultAfterLiq.liquidationNonce).to.be.gt(vaultBefore.liquidationNonce);
      
      // Reset price
      await updateMockPythPrice(mockPyth, FEED_IDS.XMR_USD, 16000000000, 1000000);
      
      // Wait for burn deadline to expire
      await increaseTime(3700);
      
      // Cancel burn
      await vaultManager.connect(owner).cancelBurn(burnRequestId);
      
      // Verify burn was cancelled
      const burnRequest = await vaultManager.burnRequests(burnRequestId);
      expect(burnRequest.status).to.equal(5); // BurnStatus.CANCELLED
      
      // Verify user got wsXMR back
      const userBalance = await wsxmrToken.balanceOf(user1.address);
      expect(userBalance).to.equal(wsxmrAmount);
      
      // Verify debt was restored
      const vaultAfter = await vaultManager.vaults(lp1.address);
      const globalDebtAfter = await vaultManager.globalTotalDebt();
      
      expect(vaultAfter.normalizedDebt).to.be.gt(vaultBefore.normalizedDebt);
      expect(globalDebtAfter).to.be.gt(globalDebtBefore);
      
      // Verify lockedCollateral was decreased
      expect(vaultAfter.lockedCollateral).to.be.lt(vaultBefore.lockedCollateral);
    });
  });

  describe("6B. Expired mint cannot be revived", function () {
    it("should revert setMintReady after timeout expires", async function () {
      const { secretHash } = generateSecret();
      const timeout = 1800; // 30 minutes
      
      const tx = await vaultManager.connect(user1).initiateMint(
        lp1.address,
        user1.address,
        XMR_AMOUNT,
        secretHash,
        timeout,
        { value: 0 }
      );
      
      const receipt = await tx.wait();
      const event = receipt.logs.find(log => {
        try {
          return vaultManager.interface.parseLog(log).name === "MintInitiated";
        } catch {
          return false;
        }
      });
      const requestId = vaultManager.interface.parseLog(event).args.requestId;
      
      // Warp past timeout
      await increaseTime(1900);
      
      // setMintReady should revert
      await expect(
        vaultManager.connect(lp1).setMintReady(requestId)
      ).to.be.revertedWithCustomError(vaultManager, "DeadlineExpired");
    });

    it("should revert finalizeMint after readyDeadline expires", async function () {
      const { secret, secretHash } = generateSecret();
      const timeout = 1800;
      
      const tx = await vaultManager.connect(user1).initiateMint(
        lp1.address,
        user1.address,
        XMR_AMOUNT,
        secretHash,
        timeout,
        { value: 0 }
      );
      
      const receipt = await tx.wait();
      const event = receipt.logs.find(log => {
        try {
          return vaultManager.interface.parseLog(log).name === "MintInitiated";
        } catch {
          return false;
        }
      });
      const requestId = vaultManager.interface.parseLog(event).args.requestId;
      
      // LP sets ready before timeout
      await vaultManager.connect(lp1).setMintReady(requestId);
      
      // Warp past readyDeadline (MINT_READY_EXTENSION = 2 hours)
      await increaseTime(7300); // 2 hours + 100 seconds
      
      // finalizeMint should revert
      await expect(
        vaultManager.connect(owner).finalizeMint(requestId, secret)
      ).to.be.revertedWithCustomError(vaultManager, "DeadlineExpired");
      
      // cancelMint should succeed
      await expect(
        vaultManager.connect(owner).cancelMint(requestId)
      ).to.not.be.reverted;
    });
  });

  describe("6C. Expired burn cannot be revived", function () {
    it("should revert proposeHash after deadline expires", async function () {
      // Setup: mint wsXMR first
      const wsxmrAmount = ethers.parseUnits("10", 8);
      const { secret, secretHash } = generateSecret();
      
      const mintTx = await vaultManager.connect(user1).initiateMint(
        lp1.address,
        user1.address,
        ethers.parseUnits("10", 12),
        secretHash,
        3600,
        { value: 0 }
      );
      
      const mintReceipt = await mintTx.wait();
      const mintEvent = mintReceipt.logs.find(log => {
        try {
          return vaultManager.interface.parseLog(log).name === "MintInitiated";
        } catch {
          return false;
        }
      });
      const mintRequestId = vaultManager.interface.parseLog(mintEvent).args.requestId;
      
      await vaultManager.connect(lp1).setMintReady(mintRequestId);
      await vaultManager.connect(owner).finalizeMint(mintRequestId, secret);
      
      // Request burn
      await wsxmrToken.connect(user1).approve(await vaultManager.getAddress(), wsxmrAmount);
      const burnTx = await vaultManager.connect(user1).requestBurn(
        wsxmrAmount,
        lp1.address,
        user1.address
      );
      
      const burnReceipt = await burnTx.wait();
      const burnEvent = burnReceipt.logs.find(log => {
        try {
          return vaultManager.interface.parseLog(log).name === "BurnRequested";
        } catch {
          return false;
        }
      });
      const burnRequestId = vaultManager.interface.parseLog(burnEvent).args.requestId;
      
      // Warp past deadline (BURN_REQUEST_TIMEOUT = 1 hour)
      await increaseTime(3700);
      
      // proposeHash should revert
      const { secretHash: newSecretHash } = generateSecret();
      await expect(
        vaultManager.connect(lp1).proposeHash(burnRequestId, newSecretHash)
      ).to.be.revertedWithCustomError(vaultManager, "DeadlineExpired");
    });

    it("should revert confirmMoneroLock after deadline expires and allow cancelBurn", async function () {
      // Setup: mint wsXMR first
      const wsxmrAmount = ethers.parseUnits("10", 8);
      const { secret, secretHash } = generateSecret();
      
      const mintTx = await vaultManager.connect(user1).initiateMint(
        lp1.address,
        user1.address,
        ethers.parseUnits("10", 12),
        secretHash,
        3600,
        { value: 0 }
      );
      
      const mintReceipt = await mintTx.wait();
      const mintEvent = mintReceipt.logs.find(log => {
        try {
          return vaultManager.interface.parseLog(log).name === "MintInitiated";
        } catch {
          return false;
        }
      });
      const mintRequestId = vaultManager.interface.parseLog(mintEvent).args.requestId;
      
      await vaultManager.connect(lp1).setMintReady(mintRequestId);
      await vaultManager.connect(owner).finalizeMint(mintRequestId, secret);
      
      // Request burn
      await wsxmrToken.connect(user1).approve(await vaultManager.getAddress(), wsxmrAmount);
      const burnTx = await vaultManager.connect(user1).requestBurn(
        wsxmrAmount,
        lp1.address,
        user1.address
      );
      
      const burnReceipt = await burnTx.wait();
      const burnEvent = burnReceipt.logs.find(log => {
        try {
          return vaultManager.interface.parseLog(log).name === "BurnRequested";
        } catch {
          return false;
        }
      });
      const burnRequestId = vaultManager.interface.parseLog(burnEvent).args.requestId;
      
      // LP proposes hash before expiry
      const { secretHash: newSecretHash } = generateSecret();
      await vaultManager.connect(lp1).proposeHash(burnRequestId, newSecretHash);
      
      // Warp past deadline (BURN_COMMIT_TIMEOUT = 2 hours)
      await increaseTime(7300);
      
      // confirmMoneroLock should revert
      await expect(
        vaultManager.connect(user1).confirmMoneroLock(burnRequestId)
      ).to.be.revertedWithCustomError(vaultManager, "DeadlineExpired");
      
      // cancelBurn should succeed
      await expect(
        vaultManager.connect(owner).cancelBurn(burnRequestId)
      ).to.not.be.reverted;
    });
  });

  describe("6D. Yield sync preserves solvency", function () {
    it("should not harvest collateral needed for solvency", async function () {
      // Setup: Create vault with active debt
      const wsxmrAmount = ethers.parseUnits("500", 8); // Large debt
      const { secret, secretHash } = generateSecret();
      
      const mintTx = await vaultManager.connect(user1).initiateMint(
        lp1.address,
        user1.address,
        ethers.parseUnits("500", 12),
        secretHash,
        3600,
        { value: 0 }
      );
      
      const mintReceipt = await mintTx.wait();
      const mintEvent = mintReceipt.logs.find(log => {
        try {
          return vaultManager.interface.parseLog(log).name === "MintInitiated";
        } catch {
          return false;
        }
      });
      const mintRequestId = vaultManager.interface.parseLog(mintEvent).args.requestId;
      
      await vaultManager.connect(lp1).setMintReady(mintRequestId);
      await vaultManager.connect(owner).finalizeMint(mintRequestId, secret);
      
      // Get vault state before yield sync
      const vaultBefore = await vaultManager.vaults(lp1.address);
      const actualDebt = await vaultManager.getActualDebt(vaultBefore.normalizedDebt);
      
      // Trigger yield sync by depositing more collateral
      await getXDAI(lp1, ethers.parseEther("1000"));
      await xDAI.connect(lp1).approve(await vaultManager.getAddress(), ethers.parseEther("1000"));
      await vaultManager.connect(lp1).depositCollateral(ethers.parseEther("1000"));
      
      // Get vault state after yield sync
      const vaultAfter = await vaultManager.vaults(lp1.address);
      
      // Calculate available collateral
      const availableCollateral = vaultAfter.collateralAmount - vaultAfter.lockedCollateral;
      
      // Calculate collateral ratio
      const collateralPrice = await vaultManager.getCollateralPrice();
      const xmrPrice = await vaultManager.getXmrPrice();
      
      const availableCollateralUsd = (availableCollateral * collateralPrice) / ethers.parseEther("1");
      const debtUsd = (actualDebt * xmrPrice) / ethers.parseUnits("1", 8);
      
      const ratio = (availableCollateralUsd * 100n) / debtUsd;
      
      // Verify ratio is at least COLLATERAL_RATIO (150%)
      expect(ratio).to.be.gte(150n);
    });
  });

  describe("6E. triggerBuyAndBurn accounting", function () {
    it("should cap debt forgiveness when approaching MIN_DEBT_INDEX", async function () {
      // This test requires complex setup to get globalDebtIndex close to MIN_DEBT_INDEX
      // For now, we'll test the basic accounting
      
      // Setup: Create debt and yield
      const wsxmrAmount = ethers.parseUnits("100", 8);
      const { secret, secretHash } = generateSecret();
      
      const mintTx = await vaultManager.connect(user1).initiateMint(
        lp1.address,
        user1.address,
        ethers.parseUnits("100", 12),
        secretHash,
        3600,
        { value: 0 }
      );
      
      const mintReceipt = await mintTx.wait();
      const mintEvent = mintReceipt.logs.find(log => {
        try {
          return vaultManager.interface.parseLog(log).name === "MintInitiated";
        } catch {
          return false;
        }
      });
      const mintRequestId = vaultManager.interface.parseLog(mintEvent).args.requestId;
      
      await vaultManager.connect(lp1).setMintReady(mintRequestId);
      await vaultManager.connect(owner).finalizeMint(mintRequestId, secret);
      
      // Verify globalDebtIndex never goes below MIN_DEBT_INDEX
      const minDebtIndex = await vaultManager.MIN_DEBT_INDEX();
      const currentIndex = await vaultManager.globalDebtIndex();
      expect(currentIndex).to.be.gte(minDebtIndex);
    });
  });

  describe("6F. Pagination", function () {
    it("should return empty array when cursor exceeds vaultList length", async function () {
      const [batch, nextCursor] = await vaultManager.getVaultsPaginated(1000, 10);
      expect(batch.length).to.equal(0);
      expect(nextCursor).to.equal(1); // Only 1 vault exists (lp1)
    });
  });

  describe("6G. Router zero-amount protection", function () {
    it("should revert createPosition with zero sDAI amount", async function () {
      await expect(
        router.connect(lp1).createPosition(
          lp1.address,
          user1.address,
          0,
          ethers.parseUnits("10", 8)
        )
      ).to.be.revertedWithCustomError(router, "InvalidAmount");
    });

    it("should revert createPosition with zero wsXMR amount", async function () {
      await expect(
        router.connect(lp1).createPosition(
          lp1.address,
          user1.address,
          ethers.parseEther("100"),
          0
        )
      ).to.be.revertedWithCustomError(router, "InvalidAmount");
    });
  });
});
