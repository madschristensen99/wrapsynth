const { ethers, network } = require("hardhat");

// Gnosis Chain addresses
const ADDRESSES = {
  SDAI: "0xaf204776c7245bF4147c2612BF6e5972Ee483701",
  XDAI: "0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d",
  PYTH_ORACLE: "0x2880aB155794e7179c9eE2e38200202908C17B43",
  UNISWAP_V3_POSITION_MANAGER: "0xC36442b4a4522E871399CD717aBDD847Ab11FE88",
  UNISWAP_V3_ROUTER: "0xE592427A0AEce92De3Edee1F18E0157C05861564",
  BALANCER_VAULT: "0xBA12222222228d8Ba445958a75a0704d566BF2C8",
};

const FEED_IDS = {
  XMR_USD: "0x46b8cc9347f04391764a0361e0b17c3ba394b001e7c304f7650f6376e37c321d",
  DAI_USD: "0xb0948a5e5313200c632b51bb5ca32f6de0d36e9950a942d19751e833f70dabfd",
};

/**
 * Get xDAI tokens for testing by impersonating a whale
 */
async function getXDAI(recipient, amount) {
  // Use sDAI contract as whale - it holds large amounts of xDAI
  const whaleAddress = "0xaf204776c7245bF4147c2612BF6e5972Ee483701"; // sDAI contract
  
  await network.provider.request({
    method: "hardhat_impersonateAccount",
    params: [whaleAddress],
  });
  
  const whale = await ethers.getSigner(whaleAddress);
  const [owner] = await ethers.getSigners();
  
  // Fund whale with native xDAI for gas
  await network.provider.send("hardhat_setBalance", [
    whaleAddress,
    "0x56BC75E2D63100000", // 100 ETH in hex
  ]);
  
  const xDAI = await ethers.getContractAt("IERC20", ADDRESSES.XDAI);
  await xDAI.connect(whale).transfer(recipient.address, amount);
  
  await network.provider.request({
    method: "hardhat_stopImpersonatingAccount",
    params: [whaleAddress],
  });
}

/**
 * Generate a random secp256k1 secret and its commitment
 * Note: For actual tests, use proper secp256k1 implementation
 */
function generateSecret() {
  const secret = ethers.randomBytes(32);
  const secretHash = ethers.keccak256(secret);
  return {
    secret: ethers.hexlify(secret),
    secretHash,
  };
}

/**
 * Setup a vault with collateral for an LP
 */
async function setupVaultWithCollateral(vaultManager, lp, daiAmount) {
  const xDAI = await ethers.getContractAt("IERC20", ADDRESSES.XDAI);
  
  // Get xDAI
  await getXDAI(lp, daiAmount);
  
  // Create vault
  await vaultManager.connect(lp).createVault(ADDRESSES.SDAI);
  
  // Approve and deposit
  await xDAI.connect(lp).approve(await vaultManager.getAddress(), daiAmount);
  await vaultManager.connect(lp).depositCollateral(daiAmount);
  
  return await vaultManager.getVault(lp.address);
}

/**
 * Create a mint request and return the request ID
 */
async function createMintRequest(vaultManager, user, lpAddress, xmrAmount, griefingDeposit) {
  const { secretHash } = generateSecret();
  const timeout = 3600; // 1 hour
  
  const tx = await vaultManager.connect(user).initiateMint(
    lpAddress,
    xmrAmount,
    secretHash, { value: griefingDeposit }
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
  return parsedEvent.args.requestId;
}

/**
 * Deploy and setup MockPyth oracle with realistic prices
 */
async function deployMockPyth() {
  const MockPyth = await ethers.getContractFactory("MockPyth");
  const mockPyth = await MockPyth.deploy();
  await mockPyth.waitForDeployment();
  
  // Get current block timestamp
  const block = await ethers.provider.getBlock("latest");
  const currentTime = block.timestamp;
  
  // XMR/USD: ~$160 (price in 8 decimals: 160 * 1e8)
  await mockPyth.setPrice(
    FEED_IDS.XMR_USD,
    16000000000, // $160
    1000000, // 0.01 confidence
    -8,
    currentTime
  );
  
  await mockPyth.setEmaPrice(
    FEED_IDS.XMR_USD,
    16100000000, // $161 (slightly higher for EMA)
    1000000,
    -8,
    currentTime
  );
  
  // DAI/USD: ~$1.00 (price in 8 decimals: 1 * 1e8)
  await mockPyth.setPrice(
    FEED_IDS.DAI_USD,
    100000000, // $1.00
    100000, // 0.001 confidence
    -8,
    currentTime
  );
  
  await mockPyth.setEmaPrice(
    FEED_IDS.DAI_USD,
    100000000,
    100000,
    -8,
    currentTime
  );
  
  return mockPyth;
}

/**
 * Update mock Pyth prices
 */
async function updateMockPythPrice(mockPyth, feedId, price, conf, expo = -8) {
  const block = await ethers.provider.getBlock("latest");
  const currentTime = block.timestamp;
  await mockPyth.setPrice(feedId, price, conf, expo, currentTime);
  await mockPyth.setEmaPrice(feedId, price, conf, expo, currentTime);
}

/**
 * Calculate expected collateral for debt amount
 */
function calculateCollateralForDebt(debtAmount, xmrPrice, collateralPrice, ratio = 150) {
  // debtAmount in wsXMR (8 decimals)
  // prices in USD (18 decimals)
  const debtValueUSD = (debtAmount * xmrPrice) / BigInt(1e8);
  const collateralValueUSD = (debtValueUSD * BigInt(ratio)) / BigInt(100);
  const collateralAmount = (collateralValueUSD * BigInt(1e18)) / collateralPrice;
  return collateralAmount;
}

/**
 * Time travel helper
 */
async function increaseTime(seconds) {
  await network.provider.send("evm_increaseTime", [seconds]);
  await network.provider.send("evm_mine");
}

/**
 * Get current block timestamp
 */
async function getCurrentTimestamp() {
  const block = await ethers.provider.getBlock("latest");
  return block.timestamp;
}

module.exports = {
  ADDRESSES,
  FEED_IDS,
  getXDAI,
  generateSecret,
  setupVaultWithCollateral,
  createMintRequest,
  deployMockPyth,
  updateMockPythPrice,
  calculateCollateralForDebt,
  increaseTime,
  getCurrentTimestamp,
};
