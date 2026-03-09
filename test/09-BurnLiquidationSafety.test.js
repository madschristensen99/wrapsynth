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
} = require("./helpers/testHelpers");

describe("Burn/Liquidation Safety Tests", function () {
  let vaultManager;
  let wsxmrToken;
  let mockPyth;
  let owner, lp1, user1, user2;
  let xDAI;

  const DAI_AMOUNT = ethers.parseEther("100000"); // 100k DAI
  const XMR_AMOUNT = ethers.parseUnits("100", 12); // 100 XMR

  beforeEach(async function () {
    [owner, lp1, user1, user2] = await ethers.getSigners();

    mockPyth = await deployMockPyth();

    const VaultManager = await ethers.getContractFactory("VaultManager");
    vaultManager = await VaultManager.deploy(await mockPyth.getAddress());
    await vaultManager.waitForDeployment();

    wsxmrToken = await ethers.getContractAt(
      "wsXMR",
      await vaultManager.wsxmrToken()
    );

    xDAI = await ethers.getContractAt("IERC20", ADDRESSES.XDAI);

    // Setup LP1 vault with collateral
    await getXDAI(lp1, DAI_AMOUNT);
    await vaultManager.connect(lp1).createVault();
    await xDAI.connect(lp1).approve(await vaultManager.getAddress(), DAI_AMOUNT);
    await vaultManager.connect(lp1).depositCollateral(DAI_AMOUNT);
  });

  describe("Burn liquidation nonce tracking", function () {
    it("should snapshot liquidationNonce when burn is requested", async function () {
      // Mint wsXMR first
      const { secret, secretHash } = generateSecret();
      const mintTx = await vaultManager.connect(user1).initiateMint(
        lp1.address,
        user1.address,
        XMR_AMOUNT,
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
      
      // Get vault state before burn
      const vaultBefore = await vaultManager.vaults(lp1.address);
      
      // Request burn
      const wsxmrAmount = ethers.parseUnits("10", 8);
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
      
      // Verify liquidationNonceAtRequest was stored
      const burnRequest = await vaultManager.burnRequests(burnRequestId);
      expect(burnRequest.liquidationNonceAtRequest).to.equal(vaultBefore.liquidationNonce);
    });

    it("should block cancelBurn if vault was liquidated after burn started", async function () {
      // Setup: mint and request burn
      const { secret, secretHash } = generateSecret();
      const mintTx = await vaultManager.connect(user1).initiateMint(
        lp1.address,
        user1.address,
        XMR_AMOUNT,
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
      
      const wsxmrAmount = ethers.parseUnits("50", 8);
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
      
      // Manipulate price to make vault liquidatable
      await updateMockPythPrice(mockPyth, FEED_IDS.XMR_USD, 50000000000, 1000000); // $500 XMR
      
      // Liquidate vault (this increments liquidationNonce)
      const debtToClear = ethers.parseUnits("10", 8);
      await wsxmrToken.connect(owner).approve(await vaultManager.getAddress(), debtToClear);
      await vaultManager.connect(owner).liquidate(lp1.address, debtToClear);
      
      // Verify liquidationNonce was incremented
      const vaultAfter = await vaultManager.vaults(lp1.address);
      const burnRequest = await vaultManager.burnRequests(burnRequestId);
      expect(vaultAfter.liquidationNonce).to.be.gt(burnRequest.liquidationNonceAtRequest);
      
      // Wait for deadline
      await increaseTime(3700);
      
      // cancelBurn should revert
      await expect(
        vaultManager.connect(owner).cancelBurn(burnRequestId)
      ).to.be.revertedWithCustomError(vaultManager, "BurnInvalidatedByLiquidation");
    });

    it("should allow cancelBurn if vault was NOT liquidated", async function () {
      // Setup: mint and request burn
      const { secret, secretHash } = generateSecret();
      const mintTx = await vaultManager.connect(user1).initiateMint(
        lp1.address,
        user1.address,
        XMR_AMOUNT,
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
      
      const wsxmrAmount = ethers.parseUnits("10", 8);
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
      
      // Wait for deadline WITHOUT liquidating
      await increaseTime(3700);
      
      // cancelBurn should succeed
      await expect(
        vaultManager.connect(owner).cancelBurn(burnRequestId)
      ).to.not.be.reverted;
      
      // Verify status
      const burnRequest = await vaultManager.burnRequests(burnRequestId);
      expect(burnRequest.status).to.equal(6); // BurnStatus.CANCELLED
      
      // Verify user got wsXMR back
      const userBalance = await wsxmrToken.balanceOf(user1.address);
      expect(userBalance).to.be.gte(wsxmrAmount);
    });
  });

  describe("claimLiquidatedBurn", function () {
    it("should allow user to claim locked collateral after vault liquidation", async function () {
      // Setup: mint and request burn
      const { secret, secretHash } = generateSecret();
      const mintTx = await vaultManager.connect(user1).initiateMint(
        lp1.address,
        user1.address,
        XMR_AMOUNT,
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
      
      const wsxmrAmount = ethers.parseUnits("50", 8);
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
      
      const burnRequestBefore = await vaultManager.burnRequests(burnRequestId);
      const expectedCollateral = burnRequestBefore.lockedCollateral + burnRequestBefore.rewardCollateral;
      
      // Liquidate vault
      await updateMockPythPrice(mockPyth, FEED_IDS.XMR_USD, 50000000000, 1000000);
      const debtToClear = ethers.parseUnits("10", 8);
      await wsxmrToken.connect(owner).approve(await vaultManager.getAddress(), debtToClear);
      await vaultManager.connect(owner).liquidate(lp1.address, debtToClear);
      
      // User claims liquidated burn
      await expect(
        vaultManager.connect(user1).claimLiquidatedBurn(burnRequestId)
      ).to.emit(vaultManager, "BurnLiquidated")
        .withArgs(burnRequestId, user1.address, expectedCollateral);
      
      // Verify status
      const burnRequestAfter = await vaultManager.burnRequests(burnRequestId);
      expect(burnRequestAfter.status).to.equal(7); // BurnStatus.LIQUIDATED
      
      // Verify collateral was queued for withdrawal
      const pendingReturns = await vaultManager.pendingReturns(user1.address, ADDRESSES.SDAI);
      expect(pendingReturns).to.equal(expectedCollateral);
    });

    it("should revert if vault was NOT liquidated", async function () {
      // Setup: mint and request burn
      const { secret, secretHash } = generateSecret();
      const mintTx = await vaultManager.connect(user1).initiateMint(
        lp1.address,
        user1.address,
        XMR_AMOUNT,
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
      
      const wsxmrAmount = ethers.parseUnits("10", 8);
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
      
      // Try to claim without liquidation
      await expect(
        vaultManager.connect(user1).claimLiquidatedBurn(burnRequestId)
      ).to.be.revertedWithCustomError(vaultManager, "BurnInvalidatedByLiquidation");
    });

    it("should revert if caller is not the burn initiator", async function () {
      // Setup: mint and request burn
      const { secret, secretHash } = generateSecret();
      const mintTx = await vaultManager.connect(user1).initiateMint(
        lp1.address,
        user1.address,
        XMR_AMOUNT,
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
      
      const wsxmrAmount = ethers.parseUnits("50", 8);
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
      
      // Liquidate vault
      await updateMockPythPrice(mockPyth, FEED_IDS.XMR_USD, 50000000000, 1000000);
      const debtToClear = ethers.parseUnits("10", 8);
      await wsxmrToken.connect(owner).approve(await vaultManager.getAddress(), debtToClear);
      await vaultManager.connect(owner).liquidate(lp1.address, debtToClear);
      
      // user2 tries to claim (should fail)
      await expect(
        vaultManager.connect(user2).claimLiquidatedBurn(burnRequestId)
      ).to.be.revertedWithCustomError(vaultManager, "Unauthorized");
    });
  });

  describe("getUserActiveBurns excludes LIQUIDATED", function () {
    it("should not return LIQUIDATED burns in active burns list", async function () {
      // Setup: mint and request burn
      const { secret, secretHash } = generateSecret();
      const mintTx = await vaultManager.connect(user1).initiateMint(
        lp1.address,
        user1.address,
        XMR_AMOUNT,
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
      
      const wsxmrAmount = ethers.parseUnits("50", 8);
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
      
      // Verify burn is active before liquidation
      let activeBurns = await vaultManager.getUserActiveBurns(user1.address);
      expect(activeBurns.length).to.equal(1);
      
      // Liquidate vault and claim
      await updateMockPythPrice(mockPyth, FEED_IDS.XMR_USD, 50000000000, 1000000);
      const debtToClear = ethers.parseUnits("10", 8);
      await wsxmrToken.connect(owner).approve(await vaultManager.getAddress(), debtToClear);
      await vaultManager.connect(owner).liquidate(lp1.address, debtToClear);
      await vaultManager.connect(user1).claimLiquidatedBurn(burnRequestId);
      
      // Verify burn is no longer active
      activeBurns = await vaultManager.getUserActiveBurns(user1.address);
      expect(activeBurns.length).to.equal(0);
    });
  });
});
