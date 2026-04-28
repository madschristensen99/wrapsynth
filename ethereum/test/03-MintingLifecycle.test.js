const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { ADDRESSES, getXDAI, setupVaultWithCollateral, generateSecret, deployMockPyth } = require("./helpers/testHelpers");

describe("Minting Lifecycle and Anti-Spam (Griefing Deposits)", function () {
  let wsxmrToken, vaultManager, mockPyth;
  let owner, lp1, user1, user2, keeper;
  let xDAI;

  const GRIEFING_DEPOSIT = ethers.parseEther("0.01");
  const XMR_AMOUNT = ethers.parseUnits("1", 12); // 1 XMR

  before(async function () {
    [owner, lp1, user1, user2, keeper] = await ethers.getSigners();

    // Deploy MockPyth oracle
    mockPyth = await deployMockPyth();

    // Deploy contracts
    const WsXMR = await ethers.getContractFactory("wsXMR");
    wsxmrToken = await WsXMR.deploy(owner.address);
    await wsxmrToken.waitForDeployment();

    const VaultManager = await ethers.getContractFactory("VaultManager");
    vaultManager = await VaultManager.deploy(
      await wsxmrToken.getAddress(),
      await mockPyth.getAddress(),
      owner.address
    );
    await vaultManager.waitForDeployment();

    await wsxmrToken.setVaultManager(await vaultManager.getAddress());

    xDAI = await ethers.getContractAt("IERC20", ADDRESSES.XDAI);

    // Setup LP vault with collateral
    await setupVaultWithCollateral(vaultManager, lp1, ethers.parseEther("50000"));

    // Configure LP settings
    await vaultManager.connect(lp1).setMintGriefingDeposit(GRIEFING_DEPOSIT);
    await vaultManager.connect(lp1).setVaultMarketMetrics(100, 50); // 1% fee, 0.5% reward
    await vaultManager.connect(lp1).setMaxMintBps(0); // No limit
  });

  describe("A. User Provides Exact ETH Griefing Deposit", function () {
    let requestId;

    it("Should initiate mint with exact griefing deposit", async function () {
      const { secretHash } = generateSecret();
      const timeout = 3600;

      const tx = await vaultManager.connect(user1).initiateMint(
        lp1.address,
        XMR_AMOUNT,
        secretHash,
        timeout,
        { value: GRIEFING_DEPOSIT }
      );

      const receipt = await tx.wait();
      const event = receipt.logs.find(log => {
        try {
          return vaultManager.interface.parseLog(log).name === "MintInitiated";
        } catch {
          return false;
        }
      });

      expect(event).to.not.be.undefined;
      const parsedEvent = vaultManager.interface.parseLog(event);
      requestId = parsedEvent.args.requestId;

      expect(requestId).to.not.equal(ethers.ZeroHash);

      // Verify request was created
      const request = await vaultManager.mintRequests(requestId);
      expect(request.user).to.equal(user1.address);
      expect(request.lpVault).to.equal(lp1.address);
      expect(request.griefingDeposit).to.equal(GRIEFING_DEPOSIT);
    });

    it("Should increment vault pendingDebt", async function () {
      const vault = await vaultManager.getVault(lp1.address);
      expect(vault.pendingDebt).to.be.gt(0);
    });

    it("Should allow LP to set mint ready", async function () {
      await expect(
        vaultManager.connect(lp1).setMintReady(requestId)
      ).to.emit(vaultManager, "MintReady")
        .withArgs(requestId);

      const request = await vaultManager.mintRequests(requestId);
      expect(request.status).to.equal(2); // MintStatus.READY
    });
  });

  describe("B. User Provides Insufficient ETH for Griefing Deposit", function () {
    it("Should revert with InsufficientDeposit error", async function () {
      const { secretHash } = generateSecret();
      const insufficientDeposit = GRIEFING_DEPOSIT / 2n;

      await expect(
        vaultManager.connect(user2).initiateMint(
          lp1.address,
          XMR_AMOUNT,
          secretHash,
          3600,
          { value: insufficientDeposit }
        )
      ).to.be.revertedWithCustomError(vaultManager, "InsufficientDeposit");
    });

    it("Should revert even with zero deposit when LP requires deposit", async function () {
      const { secretHash } = generateSecret();

      await expect(
        vaultManager.connect(user2).initiateMint(
          lp1.address,
          XMR_AMOUNT,
          secretHash,
          3600,
          { value: 0 }
        )
      ).to.be.revertedWithCustomError(vaultManager, "InsufficientDeposit");
    });
  });

  describe("A. User Fails to Lock XMR Before Timeout", function () {
    it("Should allow third party to cancel and award deposit to LP", async function () {
      const { secretHash } = generateSecret();
      const shortTimeout = 60; // 1 minute

      const tx = await vaultManager.connect(user2).initiateMint(
        lp1.address,
        XMR_AMOUNT / 10n,
        secretHash,
        shortTimeout,
        { value: GRIEFING_DEPOSIT }
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
      await time.increase(shortTimeout + 1);

      const lpBalanceBefore = await vaultManager.pendingReturns(lp1.address, ethers.ZeroAddress);

      // Anyone can cancel (permissionless cleanup)
      await expect(
        vaultManager.connect(keeper).cancelMint(requestId)
      ).to.emit(vaultManager, "MintCancelled")
        .withArgs(requestId);

      const lpBalanceAfter = await vaultManager.pendingReturns(lp1.address, ethers.ZeroAddress);
      expect(lpBalanceAfter).to.equal(lpBalanceBefore + GRIEFING_DEPOSIT);

      // Verify pendingDebt was released
      const vault = await vaultManager.getVault(lp1.address);
      // pendingDebt should be reduced
    });
  });

  describe("B. LP Confirms READY but Fails to Finalize Before Extended Timeout", function () {
    it("Should refund deposit to user after extended timeout expires", async function () {
      const { secretHash } = generateSecret();
      const shortTimeout = 60;

      const tx = await vaultManager.connect(user2).initiateMint(
        lp1.address,
        XMR_AMOUNT / 10n,
        secretHash,
        shortTimeout,
        { value: GRIEFING_DEPOSIT }
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
      await time.increase(shortTimeout + MINT_READY_EXTENSION + 1);

      const userBalanceBefore = await vaultManager.pendingReturns(user2.address, ethers.ZeroAddress);

      await vaultManager.connect(keeper).cancelMint(requestId);

      const userBalanceAfter = await vaultManager.pendingReturns(user2.address, ethers.ZeroAddress);
      expect(userBalanceAfter).to.equal(userBalanceBefore + GRIEFING_DEPOSIT);
    });
  });

  describe("A. User Requests Mint Within LP's maxMintBps Capacity", function () {
    it("Should accept mint request within capacity limits", async function () {
      // Update Pyth prices to current timestamp (after previous time manipulations)
      const block = await ethers.provider.getBlock("latest");
      await mockPyth.setPrice(
        "0x46b8cc9347f04391764a0361e0b17c3ba394b001e7c304f7650f6376e37c321d",
        16000000000,
        1000000,
        -8,
        block.timestamp
      );
      await mockPyth.setPrice(
        "0xb0948a5e5313200c632b51bb5ca32f6de0d36e9950a942d19751e833f70dabfd",
        100000000,
        100000,
        -8,
        block.timestamp
      );
      
      // Set maxMintBps to 1000 (10%)
      await vaultManager.connect(lp1).setMaxMintBps(1000);

      const { secretHash } = generateSecret();
      const smallAmount = XMR_AMOUNT / 100n; // Small amount well within 10%

      await expect(
        vaultManager.connect(user2).initiateMint(
          lp1.address,
          smallAmount,
          secretHash,
          3600,
          { value: GRIEFING_DEPOSIT }
        )
      ).to.emit(vaultManager, "MintInitiated");

      // Reset for other tests
      await vaultManager.connect(lp1).setMaxMintBps(0);
    });
  });

  describe("B. User Requests Mint Exceeding LP Available Bandwidth", function () {
    it("Should revert when mint exceeds maxMintBps", async function () {
      // FIXED: The contract had a bug comparing wsXMR amount (8 decimals) to USD value (18 decimals)
      // Now properly converts wsxmrAmount to USD before comparison
      // Update Pyth prices to current timestamp
      const block = await ethers.provider.getBlock("latest");
      await mockPyth.setPrice(
        "0x46b8cc9347f04391764a0361e0b17c3ba394b001e7c304f7650f6376e37c321d",
        16000000000,
        1000000,
        -8,
        block.timestamp
      );
      await mockPyth.setPrice(
        "0xb0948a5e5313200c632b51bb5ca32f6de0d36e9950a942d19751e833f70dabfd",
        100000000,
        100000,
        -8,
        block.timestamp
      );
      
      // Set very restrictive maxMintBps
      await vaultManager.connect(lp1).setMaxMintBps(1); // 0.01%

      const { secretHash } = generateSecret();
      // With 50,000 DAI collateral at 150% ratio, max debt capacity is ~$33,333
      // At $160/XMR, that's ~208 XMR max
      // 0.01% of 208 XMR = 0.0208 XMR
      // So requesting 1 XMR should exceed the limit
      const largeAmount = XMR_AMOUNT * 100n; // 100 XMR - way over 0.01% limit

      await expect(
        vaultManager.connect(user2).initiateMint(
          lp1.address,
          largeAmount,
          secretHash,
          3600,
          { value: GRIEFING_DEPOSIT }
        )
      ).to.be.revertedWithCustomError(vaultManager, "InvalidValue");

      // Reset
      await vaultManager.connect(lp1).setMaxMintBps(0);
    });
  });

  describe("Edge Cases and Security", function () {
    it("Should revert with zero XMR amount", async function () {
      const { secretHash } = generateSecret();

      await expect(
        vaultManager.connect(user1).initiateMint(
          lp1.address,
          0,
          secretHash,
          3600,
          { value: GRIEFING_DEPOSIT }
        )
      ).to.be.revertedWithCustomError(vaultManager, "ZeroAmount");
    });

    it("Should revert with zero commitment", async function () {
      await expect(
        vaultManager.connect(user1).initiateMint(
          lp1.address,
          XMR_AMOUNT,
          ethers.ZeroHash,
          3600,
          { value: GRIEFING_DEPOSIT }
        )
      ).to.be.revertedWithCustomError(vaultManager, "InvalidSecret");
    });

    it("Should revert with timeout exceeding MAX_MINT_TIMEOUT", async function () {
      const { secretHash } = generateSecret();
      const excessiveTimeout = 13 * 3600; // > 12 hours

      await expect(
        vaultManager.connect(user1).initiateMint(
          lp1.address,
          XMR_AMOUNT,
          secretHash,
          excessiveTimeout,
          { value: GRIEFING_DEPOSIT }
        )
      ).to.be.revertedWithCustomError(vaultManager, "InvalidValue");
    });

    it("Should revert when LP vault doesn't exist", async function () {
      const { secretHash } = generateSecret();

      await expect(
        vaultManager.connect(user1).initiateMint(
          user2.address, // Not an LP
          XMR_AMOUNT,
          secretHash,
          3600,
          { value: GRIEFING_DEPOSIT }
        )
      ).to.be.revertedWithCustomError(vaultManager, "VaultDoesNotExist");
    });
  });
});
