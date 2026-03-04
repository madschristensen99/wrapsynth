const { expect } = require("chai");
const { ethers } = require("hardhat");
const { ADDRESSES, getXDAI, setupVaultWithCollateral, deployMockPyth } = require("./helpers/testHelpers");

describe("Vault Creation and Asset Management", function () {
  let wsxmrToken, vaultManager, mockPyth;
  let owner, lp1, lp2, user1;
  let xDAI, sDAI;

  before(async function () {
    [owner, lp1, lp2, user1] = await ethers.getSigners();

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

    // Get contract instances
    xDAI = await ethers.getContractAt("IERC20", ADDRESSES.XDAI);
    sDAI = await ethers.getContractAt("ISavingsDAI", ADDRESSES.SDAI);
  });

  describe("A. User Deposits DAI into Active Vault", function () {
    it("Should create vault and deposit DAI, automatically converting to sDAI", async function () {
      const daiAmount = ethers.parseEther("10000");
      
      // Get xDAI for LP
      await getXDAI(lp1, daiAmount);
      
      // Create vault
      await expect(
        vaultManager.connect(lp1).createVault(ADDRESSES.SDAI)
      ).to.emit(vaultManager, "VaultCreated")
        .withArgs(lp1.address, ADDRESSES.SDAI);
      
      // Check vault was created
      const vault = await vaultManager.getVault(lp1.address);
      expect(vault.active).to.be.true;
      expect(vault.collateralAsset).to.equal(ADDRESSES.SDAI);
      
      // Approve and deposit
      await xDAI.connect(lp1).approve(await vaultManager.getAddress(), daiAmount);
      
      await expect(
        vaultManager.connect(lp1).depositCollateral(daiAmount)
      ).to.emit(vaultManager, "CollateralDeposited");
      
      // Verify sDAI shares were minted
      const vaultAfter = await vaultManager.getVault(lp1.address);
      expect(vaultAfter.collateralAmount).to.be.gt(0);
      
      // Verify lpPrincipalDeposits tracking
      const principal = await vaultManager.lpPrincipalDeposits(lp1.address);
      expect(principal).to.equal(daiAmount);
      
      // Verify globalLpPrincipal tracking
      const globalPrincipal = await vaultManager.globalLpPrincipal();
      expect(globalPrincipal).to.be.gte(daiAmount);
    });

    it("Should correctly increment lpPrincipalDeposits on subsequent deposits", async function () {
      const additionalAmount = ethers.parseEther("5000");
      await getXDAI(lp1, additionalAmount);
      
      const principalBefore = await vaultManager.lpPrincipalDeposits(lp1.address);
      
      await xDAI.connect(lp1).approve(await vaultManager.getAddress(), additionalAmount);
      await vaultManager.connect(lp1).depositCollateral(additionalAmount);
      
      const principalAfter = await vaultManager.lpPrincipalDeposits(lp1.address);
      expect(principalAfter).to.equal(principalBefore + additionalAmount);
    });
  });

  describe("B. User Deposits Native Asset into ERC20 Vault", function () {
    it("Should revert when depositing ETH to sDAI vault", async function () {
      await expect(
        vaultManager.connect(lp1).depositCollateral(ethers.parseEther("1"), {
          value: ethers.parseEther("1")
        })
      ).to.be.revertedWithCustomError(vaultManager, "InvalidValue");
    });

    it("Should revert when msg.value doesn't match amount for sDAI vault", async function () {
      const daiAmount = ethers.parseEther("1000");
      
      await expect(
        vaultManager.connect(lp1).depositCollateral(daiAmount, {
          value: ethers.parseEther("0.5") // Wrong value
        })
      ).to.be.revertedWithCustomError(vaultManager, "InvalidValue");
    });
  });

  describe("A. LP Requests Withdrawal of Unlocked Active Collateral", function () {
    it("Should allow withdrawal while maintaining 150% health ratio", async function () {
      const vault = await vaultManager.getVault(lp1.address);
      const withdrawAmount = vault.collateralAmount / 10n; // Withdraw 10%
      
      const xDAIBalanceBefore = await xDAI.balanceOf(lp1.address);
      
      await expect(
        vaultManager.connect(lp1).withdrawCollateral(withdrawAmount)
      ).to.emit(vaultManager, "CollateralWithdrawn");
      
      // VaultManager redeems sDAI to xDAI, so check xDAI balance
      const xDAIBalanceAfter = await xDAI.balanceOf(lp1.address);
      expect(xDAIBalanceAfter).to.be.gt(xDAIBalanceBefore);
      
      // Verify principal was decremented proportionally
      const principalAfter = await vaultManager.lpPrincipalDeposits(lp1.address);
      expect(principalAfter).to.be.lt(ethers.parseEther("15000")); // Less than total deposited
    });

    it("Should allow full withdrawal when vault has no debt", async function () {
      // Create new vault with no debt
      const daiAmount = ethers.parseEther("5000");
      await getXDAI(lp2, daiAmount);
      
      await vaultManager.connect(lp2).createVault(ADDRESSES.SDAI);
      await xDAI.connect(lp2).approve(await vaultManager.getAddress(), daiAmount);
      await vaultManager.connect(lp2).depositCollateral(daiAmount);
      
      const vault = await vaultManager.getVault(lp2.address);
      
      // Should allow full withdrawal
      await expect(
        vaultManager.connect(lp2).withdrawCollateral(vault.collateralAmount)
      ).to.emit(vaultManager, "CollateralWithdrawn");
      
      const vaultAfter = await vaultManager.getVault(lp2.address);
      expect(vaultAfter.collateralAmount).to.equal(0);
    });
  });

  describe("B. LP Attempts to Withdraw Locked Collateral", function () {
    it("Should revert when trying to withdraw more than available collateral", async function () {
      const vault = await vaultManager.getVault(lp1.address);
      const excessiveAmount = vault.collateralAmount + ethers.parseEther("1000");
      
      await expect(
        vaultManager.connect(lp1).withdrawCollateral(excessiveAmount)
      ).to.be.revertedWithCustomError(vaultManager, "InsufficientCollateral");
    });

    it("Should calculate available collateral correctly (total - locked)", async function () {
      // This will be fully tested in burn lifecycle tests
      // For now, verify the vault tracks lockedCollateral
      const vault = await vaultManager.getVault(lp1.address);
      expect(vault.lockedCollateral).to.equal(0); // No burns yet
    });
  });

  describe("Edge Cases", function () {
    it("Should revert when creating duplicate vault", async function () {
      await expect(
        vaultManager.connect(lp1).createVault(ADDRESSES.SDAI)
      ).to.be.revertedWithCustomError(vaultManager, "VaultAlreadyExists");
    });

    it("Should revert when depositing to non-existent vault", async function () {
      await expect(
        vaultManager.connect(user1).depositCollateral(ethers.parseEther("1000"))
      ).to.be.revertedWithCustomError(vaultManager, "VaultDoesNotExist");
    });

    it("Should revert when withdrawing zero amount", async function () {
      await expect(
        vaultManager.connect(lp1).withdrawCollateral(0)
      ).to.be.revertedWithCustomError(vaultManager, "ZeroAmount");
    });

    it("Should revert when depositing zero amount", async function () {
      await expect(
        vaultManager.connect(lp1).depositCollateral(0)
      ).to.be.revertedWithCustomError(vaultManager, "ZeroAmount");
    });
  });
});
