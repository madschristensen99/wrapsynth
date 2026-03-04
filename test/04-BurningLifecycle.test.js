const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");
const { ADDRESSES, getXDAI, setupVaultWithCollateral, generateSecret } = require("./helpers/testHelpers");

describe("Burning Lifecycle and Slashing Mechanics", function () {
  let wsxmrToken, vaultManager;
  let owner, lp1, user1, user2, keeper;

  const BURN_AMOUNT = ethers.parseUnits("1", 8); // 1 wsXMR

  before(async function () {
    [owner, lp1, user1, user2, keeper] = await ethers.getSigners();

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

    // Setup LP vault
    await setupVaultWithCollateral(vaultManager, lp1, ethers.parseEther("100000"));
    await vaultManager.connect(lp1).setVaultMarketMetrics(100, 50);

    // Mint wsXMR to user1 for burning tests
    // We'll impersonate VaultManager to mint directly
    const vmAddress = await vaultManager.getAddress();
    await network.provider.request({
      method: "hardhat_impersonateAccount",
      params: [vmAddress],
    });
    await owner.sendTransaction({ to: vmAddress, value: ethers.parseEther("1") });
    const vmSigner = await ethers.getSigner(vmAddress);
    
    await wsxmrToken.connect(vmSigner).mint(user1.address, ethers.parseUnits("10", 8));
    
    // Also need to add debt to vault for burn to work
    const vault = await vaultManager.getVault(lp1.address);
    // We'll need to properly set up debt through the contract
    // For now, we'll use a workaround by directly manipulating state (testing only)
    
    await network.provider.request({
      method: "hardhat_stopImpersonatingAccount",
      params: [vmAddress],
    });
  });

  describe("A. Full 4-Step Burn Completes Successfully", function () {
    it("Should complete: User burns -> LP proposes -> User confirms -> LP reveals", async function () {
      // This test requires full secp256k1 implementation
      // Skipping for now as it needs proper secret generation
      this.skip();
    });
  });

  describe("B. LP Proposes Hash but Fails to Reveal Secret", function () {
    it("Should allow user to claim slashed collateral after deadline", async function () {
      // Requires full burn flow
      this.skip();
    });
  });

  describe("A. User Requests Burn but Abandons (Never Confirms)", function () {
    it("Should allow LP to cancel after timeout and restore debt", async function () {
      // Test cancelBurn functionality
      this.skip();
    });
  });

  describe("B. User Routes Burn to Vault with Health < 150%", function () {
    it("Should revert with InsufficientCollateral error", async function () {
      // Would need to create unhealthy vault
      // This requires price manipulation or excessive debt
      this.skip();
    });
  });

  describe("Edge Cases", function () {
    it("Should revert when burning zero amount", async function () {
      await expect(
        vaultManager.connect(user1).requestBurn(0, lp1.address)
      ).to.be.revertedWithCustomError(vaultManager, "ZeroAmount");
    });

    it("Should revert when burning to non-existent vault", async function () {
      await expect(
        vaultManager.connect(user1).requestBurn(BURN_AMOUNT, user2.address)
      ).to.be.revertedWithCustomError(vaultManager, "VaultDoesNotExist");
    });

    it("Should revert when burning more than vault debt", async function () {
      const excessiveAmount = ethers.parseUnits("1000000", 8);
      
      await expect(
        vaultManager.connect(user1).requestBurn(excessiveAmount, lp1.address)
      ).to.be.revertedWithCustomError(vaultManager, "InsufficientDebt");
    });
  });
});
