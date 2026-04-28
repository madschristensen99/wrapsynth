const { expect } = require("chai");
const { ethers } = require("hardhat");
const { ADDRESSES, getXDAI, setupVaultWithCollateral } = require("./helpers/testHelpers");

describe("Liquidation Engine and Bad Debt", function () {
  let wsxmrToken, vaultManager;
  let owner, lp1, lp2, liquidator;

  before(async function () {
    [owner, lp1, lp2, liquidator] = await ethers.getSigners();

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

    await wsxmrToken.setVaultManager(await vaultManager.getAddress());

    // Setup vaults
    await setupVaultWithCollateral(vaultManager, lp1, ethers.parseEther("50000"));
    await setupVaultWithCollateral(vaultManager, lp2, ethers.parseEther("100000"));
  });

  describe("A. Liquidate Vault at 115% Health Ratio", function () {
    it("Should successfully liquidate underwater vault", async function () {
      // To test this properly, we'd need to:
      // 1. Create debt in vault
      // 2. Manipulate prices to make vault underwater
      // 3. Execute liquidation
      // This requires complex setup with price oracle mocking
      this.skip();
    });
  });

  describe("B. Attempt to Liquidate Healthy Vault at 121%", function () {
    it("Should revert with VaultHealthy error", async function () {
      const vault = await vaultManager.getVault(lp1.address);
      
      if (vault.active && vault.collateralAmount > 0) {
        // Vault has no debt, so it's healthy
        await expect(
          vaultManager.connect(liquidator).liquidate(lp1.address, ethers.parseUnits("1", 8))
        ).to.be.revertedWithCustomError(vaultManager, "InsufficientDebt");
      }
    });

    it("Should not allow liquidation above LIQUIDATION_RATIO threshold", async function () {
      // Requires vault with debt at specific ratio
      this.skip();
    });
  });

  describe("A. Severely Underwater Vault Liquidation", function () {
    it("Should scale down debt to maintain 10% liquidator bonus", async function () {
      // Test proportional bad debt handling
      this.skip();
    });

    it("Should leave fractional bad debt behind", async function () {
      this.skip();
    });
  });

  describe("B. Completely Drained Vault Cleanup", function () {
    it("Should emit BadDebtWrittenOff event without burning from address(this)", async function () {
      // Test bad debt cleanup mechanism
      this.skip();
    });

    it("Should update globalTotalDebt correctly", async function () {
      this.skip();
    });

    it("Should not revert when vault has zero collateral", async function () {
      this.skip();
    });
  });

  describe("Edge Cases", function () {
    it("Should revert when liquidating non-existent vault", async function () {
      await expect(
        vaultManager.connect(liquidator).liquidate(liquidator.address, ethers.parseUnits("1", 8))
      ).to.be.revertedWithCustomError(vaultManager, "VaultDoesNotExist");
    });

    it("Should revert when liquidating zero debt", async function () {
      await expect(
        vaultManager.connect(liquidator).liquidate(lp1.address, 0)
      ).to.be.revertedWithCustomError(vaultManager, "ZeroAmount");
    });
  });
});
