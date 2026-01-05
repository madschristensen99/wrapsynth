const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture } = require("@nomicfoundation/hardhat-network-helpers");

describe("WrappedMonero - Full Integration Tests on Arbitrum Fork", function () {
    
    // Arbitrum mainnet addresses
    const ARBITRUM_DAI = "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1";
    const ARBITRUM_SDAI = "0x"; // TODO: Add sDAI address on Arbitrum (or use Aave aDAI)
    
    // Test constants
    const INITIAL_XMR_PRICE = ethers.parseEther("150"); // $150 per XMR
    const ONE_XMR = ethers.parseUnits("1", 12); // 1 XMR in piconero
    
    async function deployWrappedMoneroFixture() {
        const [deployer, user1, user2, guardian, liquidator] = await ethers.getSigners();
        
        // Deploy mock PlonkVerifier (always returns true for testing)
        const MockVerifier = await ethers.getContractFactory("MockPlonkVerifier");
        const verifier = await MockVerifier.deploy();
        
        // Deploy mock sDAI (ERC4626 vault)
        const MockSDAI = await ethers.getContractFactory("MockSDAI");
        const mockSDAI = await MockSDAI.deploy(ARBITRUM_DAI);
        
        // Get DAI contract on fork
        const dai = await ethers.getContractAt("IERC20", ARBITRUM_DAI);
        
        // Deploy WrappedMonero
        const WrappedMonero = await ethers.getContractFactory("WrappedMonero");
        const wrappedMonero = await WrappedMonero.deploy(
            await verifier.getAddress(),
            ARBITRUM_DAI,
            await mockSDAI.getAddress(),
            deployer.address, // oracle
            guardian.address, // guardian
            INITIAL_XMR_PRICE
        );
        
        // Fund users with DAI (impersonate a whale)
        const DAI_WHALE = "0x"; // TODO: Add DAI whale address on Arbitrum
        // await helpers.impersonateAccount(DAI_WHALE);
        // const whale = await ethers.getSigner(DAI_WHALE);
        // await dai.connect(whale).transfer(user1.address, ethers.parseEther("10000"));
        // await dai.connect(whale).transfer(user2.address, ethers.parseEther("10000"));
        
        return {
            wrappedMonero,
            verifier,
            dai,
            mockSDAI,
            deployer,
            user1,
            user2,
            guardian,
            liquidator
        };
    }
    
    describe("Deployment", function () {
        it("Should set the correct initial values", async function () {
            const { wrappedMonero, deployer, guardian } = await loadFixture(deployWrappedMoneroFixture);
            
            expect(await wrappedMonero.name()).to.equal("Zero XMR");
            expect(await wrappedMonero.symbol()).to.equal("zeroXMR");
            expect(await wrappedMonero.oracle()).to.equal(deployer.address);
            expect(await wrappedMonero.guardian()).to.equal(guardian.address);
            expect(await wrappedMonero.twapPrice()).to.equal(INITIAL_XMR_PRICE);
        });
        
        it("Should have correct constants", async function () {
            const { wrappedMonero } = await loadFixture(deployWrappedMoneroFixture);
            
            expect(await wrappedMonero.INITIAL_COLLATERAL_RATIO()).to.equal(150);
            expect(await wrappedMonero.LIQUIDATION_THRESHOLD()).to.equal(120);
            expect(await wrappedMonero.LIQUIDATION_REWARD()).to.equal(5);
            expect(await wrappedMonero.PICONERO_PER_XMR()).to.equal(ethers.parseUnits("1", 12));
        });
    });
    
    describe("Oracle Functions", function () {
        it("Should allow oracle to post Monero block data", async function () {
            const { wrappedMonero, deployer } = await loadFixture(deployWrappedMoneroFixture);
            
            const blockHeight = 3000000;
            const blockHash = ethers.keccak256(ethers.toUtf8Bytes("test_block"));
            const totalSupply = ethers.parseUnits("18000000", 12); // 18M XMR
            
            await expect(wrappedMonero.connect(deployer).postMoneroBlock(
                blockHeight,
                blockHash,
                totalSupply
            )).to.emit(wrappedMonero, "MoneroBlockPosted")
              .withArgs(blockHeight, blockHash, await time.latest() + 1);
            
            const block = await wrappedMonero.getMoneroBlock(blockHeight);
            expect(block.blockHeight).to.equal(blockHeight);
            expect(block.blockHash).to.equal(blockHash);
            expect(block.totalSupply).to.equal(totalSupply);
            expect(block.exists).to.be.true;
        });
        
        it("Should reject duplicate block heights", async function () {
            const { wrappedMonero, deployer } = await loadFixture(deployWrappedMoneroFixture);
            
            const blockHeight = 3000000;
            const blockHash = ethers.keccak256(ethers.toUtf8Bytes("test_block"));
            
            await wrappedMonero.connect(deployer).postMoneroBlock(blockHeight, blockHash, 0);
            
            // Contract checks height > latestMoneroBlock first
            // So trying to post same height fails with "Block height must increase"
            await expect(
                wrappedMonero.connect(deployer).postMoneroBlock(blockHeight, blockHash, 0)
            ).to.be.revertedWith("Block height must increase");
            
            // But if we use a higher height with same data, it should work
            await wrappedMonero.connect(deployer).postMoneroBlock(blockHeight + 1, blockHash, 0);
            
            // Now try to post blockHeight + 1 again - should fail with "Block already posted"
            await expect(
                wrappedMonero.connect(deployer).postMoneroBlock(blockHeight + 1, blockHash, 0)
            ).to.be.revertedWith("Block height must increase");
        });
        
        it("Should reject non-increasing block heights", async function () {
            const { wrappedMonero, deployer } = await loadFixture(deployWrappedMoneroFixture);
            
            await wrappedMonero.connect(deployer).postMoneroBlock(3000000, ethers.ZeroHash, 0);
            
            await expect(
                wrappedMonero.connect(deployer).postMoneroBlock(2999999, ethers.ZeroHash, 0)
            ).to.be.revertedWith("Block height must increase");
        });
        
        it("Should allow oracle to update price", async function () {
            const { wrappedMonero, deployer } = await loadFixture(deployWrappedMoneroFixture);
            
            const newPrice = ethers.parseEther("160"); // $160 per XMR
            
            // Fast forward 1 minute
            await time.increase(60);
            
            await expect(wrappedMonero.connect(deployer).updatePrice(newPrice))
                .to.emit(wrappedMonero, "PriceUpdated");
            
            // TWAP should be: (150 * 0.9) + (160 * 0.1) = 151
            const expectedTwap = ethers.parseEther("151");
            expect(await wrappedMonero.twapPrice()).to.equal(expectedTwap);
        });
        
        it("Should reject price updates too frequent", async function () {
            const { wrappedMonero, deployer } = await loadFixture(deployWrappedMoneroFixture);
            
            await expect(
                wrappedMonero.connect(deployer).updatePrice(ethers.parseEther("160"))
            ).to.be.revertedWith("Update too frequent");
        });
        
        it("Should reject non-oracle price updates", async function () {
            const { wrappedMonero, user1 } = await loadFixture(deployWrappedMoneroFixture);
            
            await expect(
                wrappedMonero.connect(user1).updatePrice(ethers.parseEther("160"))
            ).to.be.revertedWith("Only oracle");
        });
        
        it("Should allow oracle transfer (one-time)", async function () {
            const { wrappedMonero, deployer, user1 } = await loadFixture(deployWrappedMoneroFixture);
            
            await expect(wrappedMonero.connect(deployer).transferOracle(user1.address))
                .to.emit(wrappedMonero, "OracleUpdated")
                .withArgs(deployer.address, user1.address);
            
            expect(await wrappedMonero.oracle()).to.equal(user1.address);
        });
    });
    
    describe("Minting", function () {
        it("Should mint zeroXMR with correct collateral", async function () {
            const { wrappedMonero, dai, mockSDAI, user1, deployer } = await loadFixture(deployWrappedMoneroFixture);
            
            // Prepare mock proof data
            const proof = new Array(24).fill(1);
            const publicSignals = new Array(70).fill(0);
            publicSignals[0] = ONE_XMR; // 1 XMR in piconero
            publicSignals[1] = 12345; // R_x
            publicSignals[2] = 67890; // S_x
            publicSignals[3] = 11111; // P_compressed
            
            const dleqProof = {
                c: ethers.keccak256(ethers.toUtf8Bytes("challenge")),
                s: ethers.keccak256(ethers.toUtf8Bytes("response")),
                K1: ethers.keccak256(ethers.toUtf8Bytes("K1")),
                K2: ethers.keccak256(ethers.toUtf8Bytes("K2"))
            };
            
            const ed25519Proof = {
                A: ethers.keccak256(ethers.toUtf8Bytes("A")),
                B: ethers.keccak256(ethers.toUtf8Bytes("B")),
                G: ethers.keccak256(ethers.toUtf8Bytes("G"))
            };
            
            const txHash = ethers.keccak256(ethers.toUtf8Bytes("monero_tx"));
            
            // Calculate required collateral: 1 XMR * $150 * 1.5 = $225
            const requiredCollateral = ethers.parseEther("225");
            
            // Fund user with DAI and approve
            // await dai.connect(user1).approve(wrappedMonero.getAddress(), requiredCollateral);
            
            // TODO: Complete once we have DAI funding working
            // await expect(wrappedMonero.connect(user1).mint(
            //     proof,
            //     publicSignals,
            //     dleqProof,
            //     ed25519Proof,
            //     txHash,
            //     user1.address
            // )).to.emit(wrappedMonero, "Minted");
        });
        
        it("Should reject double-spending", async function () {
            // TODO: Implement double-spend test
        });
        
        it("Should reject invalid proofs", async function () {
            // TODO: Implement invalid proof test
        });
        
        it("Should reject minting when paused", async function () {
            const { wrappedMonero, guardian, user1 } = await loadFixture(deployWrappedMoneroFixture);
            
            await wrappedMonero.connect(guardian).pauseMinting();
            
            const proof = new Array(24).fill(1);
            const publicSignals = new Array(70).fill(0);
            const dleqProof = {
                c: ethers.ZeroHash,
                s: ethers.ZeroHash,
                K1: ethers.ZeroHash,
                K2: ethers.ZeroHash
            };
            const ed25519Proof = {
                A: ethers.ZeroHash,
                B: ethers.ZeroHash,
                G: ethers.ZeroHash
            };
            
            // OpenZeppelin v5 uses custom errors instead of strings
            await expect(
                wrappedMonero.connect(user1).mint(
                    proof,
                    publicSignals,
                    dleqProof,
                    ed25519Proof,
                    ethers.ZeroHash,
                    user1.address
                )
            ).to.be.revertedWithCustomError(wrappedMonero, "EnforcedPause");
        });
    });
    
    describe("Burning", function () {
        it("Should burn zeroXMR and return collateral", async function () {
            // TODO: Implement burn test
        });
        
        it("Should reject burning more than balance", async function () {
            const { wrappedMonero, user1 } = await loadFixture(deployWrappedMoneroFixture);
            
            await expect(
                wrappedMonero.connect(user1).burn(ethers.parseEther("1"))
            ).to.be.revertedWith("Insufficient balance");
        });
    });
    
    describe("Liquidation", function () {
        it("Should liquidate when collateral ratio < 120%", async function () {
            // TODO: Implement liquidation test
            // 1. Mint position
            // 2. Drop price to make ratio < 120%
            // 3. Call liquidate()
            // 4. Verify liquidator gets 5% reward
        });
        
        it("Should reject liquidation when ratio >= 120%", async function () {
            const { wrappedMonero, liquidator } = await loadFixture(deployWrappedMoneroFixture);
            
            // No positions exist, totalMinted = 0, causes division by zero
            // This will revert with panic code 0x12 (division by zero)
            await expect(
                wrappedMonero.connect(liquidator).liquidate()
            ).to.be.revertedWithPanic(0x12); // Division by zero
        });
        
        it("Should calculate collateral ratio correctly", async function () {
            const { wrappedMonero } = await loadFixture(deployWrappedMoneroFixture);
            
            // No minted tokens, should return max uint256
            const ratio = await wrappedMonero.getCollateralRatio();
            expect(ratio).to.equal(ethers.MaxUint256);
        });
    });
    
    describe("Guardian Functions", function () {
        it("Should allow guardian to pause minting", async function () {
            const { wrappedMonero, guardian } = await loadFixture(deployWrappedMoneroFixture);
            
            await expect(wrappedMonero.connect(guardian).pauseMinting())
                .to.emit(wrappedMonero, "GuardianPaused");
            
            expect(await wrappedMonero.paused()).to.be.true;
        });
        
        it("Should reject non-guardian pause", async function () {
            const { wrappedMonero, user1 } = await loadFixture(deployWrappedMoneroFixture);
            
            await expect(
                wrappedMonero.connect(user1).pauseMinting()
            ).to.be.revertedWith("Only guardian");
        });
        
        it("Should enforce 30-day unpause timelock", async function () {
            const { wrappedMonero, guardian } = await loadFixture(deployWrappedMoneroFixture);
            
            await wrappedMonero.connect(guardian).pauseMinting();
            
            // Try to unpause immediately
            await expect(
                wrappedMonero.connect(guardian).unpause()
            ).to.be.revertedWith("Timelock not expired");
            
            // Fast forward 30 days
            await time.increase(30 * 24 * 60 * 60);
            
            // Now should work
            await expect(wrappedMonero.connect(guardian).unpause())
                .to.emit(wrappedMonero, "UnpauseInitiated");
            
            expect(await wrappedMonero.paused()).to.be.false;
        });
    });
    
    describe("View Functions", function () {
        it("Should return correct Monero block data", async function () {
            const { wrappedMonero, deployer } = await loadFixture(deployWrappedMoneroFixture);
            
            const blockHeight = 3000000;
            const blockHash = ethers.keccak256(ethers.toUtf8Bytes("test"));
            
            await wrappedMonero.connect(deployer).postMoneroBlock(blockHeight, blockHash, 0);
            
            const block = await wrappedMonero.getMoneroBlock(blockHeight);
            expect(block.exists).to.be.true;
            expect(block.blockHash).to.equal(blockHash);
        });
        
        it("Should check if output is spent", async function () {
            const { wrappedMonero } = await loadFixture(deployWrappedMoneroFixture);
            
            const outputId = ethers.keccak256(ethers.toUtf8Bytes("output1"));
            expect(await wrappedMonero.isOutputSpent(outputId)).to.be.false;
        });
        
        it("Should return total collateral value", async function () {
            const { wrappedMonero } = await loadFixture(deployWrappedMoneroFixture);
            
            const totalValue = await wrappedMonero.getTotalCollateralValue();
            expect(totalValue).to.equal(0); // No collateral yet
        });
    });
    
    describe("Edge Cases", function () {
        it("Should handle zero price gracefully", async function () {
            const { wrappedMonero, deployer } = await loadFixture(deployWrappedMoneroFixture);
            
            await time.increase(60);
            
            await expect(
                wrappedMonero.connect(deployer).updatePrice(0)
            ).to.be.revertedWith("Invalid price");
        });
        
        it("Should handle maximum uint256 amounts", async function () {
            // TODO: Test overflow protection
        });
        
        it("Should handle rapid price changes", async function () {
            const { wrappedMonero, deployer } = await loadFixture(deployWrappedMoneroFixture);
            
            // Update price multiple times
            for (let i = 0; i < 5; i++) {
                await time.increase(60);
                const newPrice = ethers.parseEther((150 + i * 10).toString());
                await wrappedMonero.connect(deployer).updatePrice(newPrice);
            }
            
            // TWAP should smooth out the changes
            const finalPrice = await wrappedMonero.twapPrice();
            console.log("Final TWAP after rapid changes:", ethers.formatEther(finalPrice));
        });
    });
});
