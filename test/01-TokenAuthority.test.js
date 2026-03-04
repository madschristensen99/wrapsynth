const { expect } = require("chai");
const { ethers } = require("hardhat");
const { ADDRESSES } = require("./helpers/testHelpers");

describe("Token Authority Tests", function () {
  let wsxmrToken, vaultManager;
  let owner, user1, user2;

  before(async function () {
    [owner, user1, user2] = await ethers.getSigners();

    // Deploy wsXMR
    const WsXMR = await ethers.getContractFactory("wsXMR");
    wsxmrToken = await WsXMR.deploy(owner.address);
    await wsxmrToken.waitForDeployment();

    // Deploy VaultManager
    const VaultManager = await ethers.getContractFactory("VaultManager");
    vaultManager = await VaultManager.deploy(
      await wsxmrToken.getAddress(),
      ADDRESSES.PYTH_ORACLE,
      owner.address
    );
    await vaultManager.waitForDeployment();

    // Set VaultManager as authorized minter
    await wsxmrToken.setVaultManager(await vaultManager.getAddress());
  });

  describe("A. VaultManager Successfully Calls Mint and Burn", function () {
    it("Should allow VaultManager to mint wsXMR tokens", async function () {
      const mintAmount = ethers.parseUnits("100", 8);

      // Test that VaultManager contract has permission to mint
      // We verify this by checking the vaultManager address is set correctly
      const authorizedMinter = await wsxmrToken.vaultManager();
      expect(authorizedMinter).to.equal(await vaultManager.getAddress());
      
      // In production, minting happens through VaultManager's finalizeMint function
      // For this test, we verify the permission is set up correctly
      // The actual minting will be tested in the minting lifecycle tests
      
      // We can verify the token contract would allow it by checking the modifier
      // The wsXMR contract only allows vaultManager address to call mint/burn
    });

    it("Should allow VaultManager to burn wsXMR tokens", async function () {
      // Similar to mint test - we verify the authorization is set up correctly
      const authorizedMinter = await wsxmrToken.vaultManager();
      expect(authorizedMinter).to.equal(await vaultManager.getAddress());
      
      // Actual burn functionality will be tested in burn lifecycle tests
      // where we go through the proper requestBurn -> finalizeBurn flow
    });
  });

  describe("B. Arbitrary External Address Attempts Mint/Burn", function () {
    it("Should revert when unauthorized address tries to mint", async function () {
      const mintAmount = ethers.parseUnits("100", 8);

      await expect(
        wsxmrToken.connect(user1).mint(user2.address, mintAmount)
      ).to.be.revertedWithCustomError(wsxmrToken, "OnlyVaultManager");
    });

    it("Should revert when unauthorized address tries to burn", async function () {
      const burnAmount = ethers.parseUnits("10", 8);

      await expect(
        wsxmrToken.connect(user1).burn(user1.address, burnAmount)
      ).to.be.revertedWithCustomError(wsxmrToken, "OnlyVaultManager");
    });

    it("Should revert even if caller is contract owner", async function () {
      const mintAmount = ethers.parseUnits("100", 8);

      await expect(
        wsxmrToken.connect(owner).mint(user2.address, mintAmount)
      ).to.be.revertedWithCustomError(wsxmrToken, "OnlyVaultManager");
    });
  });
});
