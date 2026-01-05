const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time, loadFixture, impersonateAccount, setBalance } = require("@nomicfoundation/hardhat-network-helpers");
const { getRealTransactionProof, calculateRequiredCollateral, realTransactions } = require("./helpers/realMoneroData");
const { getMoneroBlockData, getLatestBlockHeight } = require("./helpers/moneroRPC");

/**
 * GNOSIS CHAIN FORK TESTS
 * 
 * Tests WrappedMonero deployment on Gnosis Chain with:
 * - xDAI as collateral currency
 * - Aave V3 for yield-bearing collateral (aGnoDAI)
 * - Uniswap V3 for price oracle
 * - Real Monero transaction data
 */

describe("WrappedMonero - Gnosis Chain Fork Integration", function () {
    
    // Gnosis Chain contract addresses
    const GNOSIS_WXDAI = "0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d"; // Wrapped xDAI
    const GNOSIS_AAVE_POOL = "0xb50201558B00496A145fE76f7424749556E326D8"; // Aave V3 Pool
    const GNOSIS_AAVE_WXDAI = "0xd0Dd6cEF72143E22cCED4867eb0d5F2328715533"; // aGnoDAI (Aave V3 xDAI)
    const GNOSIS_UNISWAP_V3_FACTORY = "0x1F98431c8aD98523631AE4a59f267346ea31F984";
    const GNOSIS_UNISWAP_V3_ROUTER = "0xE592427A0AEce92De3Edee1F18E0157C05861564";
    
    // Whale addresses (large xDAI holders on Gnosis)
    const WXDAI_WHALE = "0x4ECaBa5870353805a9F068101A40E0f32ed605C6"; // Gnosis Bridge
    
    // Test constants
    const INITIAL_XMR_PRICE = ethers.parseEther("150"); // $150 per XMR
    
    // Uniswap V3 Pool ABI (minimal)
    const IUniswapV3Pool = [
        "function initialize(uint160 sqrtPriceX96) external",
        "function token0() external view returns (address)",
        "function token1() external view returns (address)",
        "function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)"
    ];
    
    // Aave V3 Pool ABI (minimal)
    const IAavePool = [
        "function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode) external",
        "function withdraw(address asset, uint256 amount, address to) external returns (uint256)"
    ];
    
    // ERC20 ABI with WETH-style deposit
    const IERC20_ABI = [
        "function balanceOf(address) view returns (uint256)",
        "function transfer(address, uint256) returns (bool)",
        "function approve(address, uint256) returns (bool)",
        "function name() view returns (string)",
        "function symbol() view returns (string)",
        "function decimals() view returns (uint8)",
        "function deposit() payable",
        "function withdraw(uint256)"
    ];
    
    async function deployOnGnosisFixture() {
        const [deployer, user1, user2, liquidator] = await ethers.getSigners();
        
        console.log("\n🔧 Deploying contracts on Gnosis Chain fork...");
        
        // Deploy mock verifier
        const MockPlonkVerifier = await ethers.getContractFactory("MockPlonkVerifier");
        const verifier = await MockPlonkVerifier.deploy();
        console.log(`✅ MockPlonkVerifier deployed: ${await verifier.getAddress()}`);
        
        // Connect to real Wrapped xDAI
        const wxdai = new ethers.Contract(GNOSIS_WXDAI, IERC20_ABI, deployer);
        console.log(`✅ Connected to WxDAI: ${GNOSIS_WXDAI}`);
        
        // Connect to Aave V3 aGnoDAI (yield-bearing xDAI)
        const aGnoDAI = new ethers.Contract(GNOSIS_AAVE_WXDAI, IERC20_ABI, deployer);
        console.log(`✅ Connected to aGnoDAI (Aave V3): ${GNOSIS_AAVE_WXDAI}`);
        
        // Deploy ERC4626 wrapper for Aave V3
        const AaveV3ERC4626Wrapper = await ethers.getContractFactory("AaveV3ERC4626Wrapper");
        const aaveWrapper = await AaveV3ERC4626Wrapper.deploy(
            GNOSIS_AAVE_POOL,
            GNOSIS_AAVE_WXDAI,
            "Wrapped Aave Gnosis xDAI",
            "waGnoDAI"
        );
        console.log(`✅ AaveV3ERC4626Wrapper deployed: ${await aaveWrapper.getAddress()}`);
        
        // Deploy WrappedMonero with Aave wrapper
        const WrappedMonero = await ethers.getContractFactory("WrappedMonero");
        const wrappedMonero = await WrappedMonero.deploy(
            await verifier.getAddress(),
            GNOSIS_WXDAI,
            await aaveWrapper.getAddress(), // Use ERC4626 wrapper
            deployer.address, // oracle
            deployer.address, // guardian
            INITIAL_XMR_PRICE
        );
        console.log(`✅ WrappedMonero deployed: ${await wrappedMonero.getAddress()}`);
        
        // Connect to Uniswap V3
        const uniswapFactory = new ethers.Contract(
            GNOSIS_UNISWAP_V3_FACTORY,
            ["function createPool(address tokenA, address tokenB, uint24 fee) external returns (address pool)",
             "function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool)"],
            deployer
        );
        console.log(`✅ Connected to Uniswap V3 on Gnosis`);
        
        // Fund users with native xDAI and wrap it
        console.log("\n💰 Funding test accounts with xDAI...");
        
        // On Gnosis, xDAI is native - just give users native balance
        const fundAmount = ethers.parseEther("100000"); // 100k xDAI each
        await setBalance(user1.address, fundAmount);
        await setBalance(user2.address, fundAmount);
        await setBalance(deployer.address, fundAmount);
        
        console.log("✅ Funded user1 with 100k native xDAI");
        console.log("✅ Funded user2 with 100k native xDAI");
        console.log("✅ Funded deployer with 100k native xDAI");
        
        // Wrap xDAI to WxDAI for contract use
        // WxDAI has a deposit() function to wrap native xDAI
        const wrapAmount = ethers.parseEther("50000"); // Wrap 50k each
        await wxdai.connect(user1).deposit({ value: wrapAmount });
        await wxdai.connect(user2).deposit({ value: wrapAmount });
        await wxdai.connect(deployer).deposit({ value: wrapAmount });
        
        // Verify wrapped balances
        const user1Balance = await wxdai.balanceOf(user1.address);
        const user2Balance = await wxdai.balanceOf(user2.address);
        const deployerBalance = await wxdai.balanceOf(deployer.address);
        console.log(`   user1 WxDAI balance: ${ethers.formatEther(user1Balance)} WxDAI`);
        console.log(`   user2 WxDAI balance: ${ethers.formatEther(user2Balance)} WxDAI`);
        console.log(`   deployer WxDAI balance: ${ethers.formatEther(deployerBalance)} WxDAI`);
        
        return {
            wrappedMonero,
            verifier,
            wxdai,
            aGnoDAI,
            aaveWrapper,
            uniswapFactory,
            deployer,
            user1,
            user2,
            liquidator
        };
    }
    
    describe("Deployment on Gnosis Fork", function () {
        it("Should deploy all contracts successfully", async function () {
            const { wrappedMonero, wxdai, aGnoDAI } = await loadFixture(deployOnGnosisFixture);
            
            expect(await wrappedMonero.name()).to.equal("Zero XMR");
            expect(await wrappedMonero.symbol()).to.equal("zeroXMR");
            expect(await wxdai.balanceOf(await wrappedMonero.getAddress())).to.equal(0);
        });
        
        it("Should have real WxDAI and Aave contracts", async function () {
            const { wxdai, aGnoDAI } = await loadFixture(deployOnGnosisFixture);
            
            console.log("\n📊 WxDAI Contract Info:");
            console.log(`   Name: ${await wxdai.name()}`);
            console.log(`   Symbol: ${await wxdai.symbol()}`);
            console.log(`   Decimals: ${await wxdai.decimals()}`);
            
            console.log("\n📊 aGnoDAI (Aave) Contract Info:");
            console.log(`   Name: ${await aGnoDAI.name()}`);
            console.log(`   Symbol: ${await aGnoDAI.symbol()}`);
            console.log(`   Decimals: ${await aGnoDAI.decimals()}`);
        });
    });
    
    describe("Real Monero Transaction Testing on Gnosis", function () {
        it("Should mint zeroXMR from real Monero transactions", async function () {
            const { wrappedMonero, wxdai, user1, user2 } = await loadFixture(deployOnGnosisFixture);
            
            console.log("\n💎 Testing with REAL Monero transaction data on Gnosis...");
            console.log("   Using 4 actual transactions (3 stagenet + 1 mainnet)\n");
            
            const xmrPrice = ethers.parseEther("150"); // $150 per XMR
            
            // Post Monero blocks first (required by postMoneroOutputs)
            for (let i = 0; i < 4; i++) {
                await wrappedMonero.postMoneroBlock(
                    1000000 + i,
                    ethers.keccak256(ethers.toUtf8Bytes(`block_${i}`)),
                    ethers.parseUnits("7000000", 12) // 7M XMR supply
                );
            }
            
            // Post outputs to oracle (Security Fix #3 requirement)
            const amounts = ["0.02", "0.01", "0.00115", "0.931064529072"];
            const outputs = [];
            for (let i = 0; i < 4; i++) {
                const txData = getRealTransactionProof(i);
                outputs.push({
                    txHash: txData.txHash,
                    outputIndex: 0,
                    ecdhAmount: ethers.keccak256(ethers.toUtf8Bytes(`ecdh_${i}`)),
                    outputPubKey: txData.ed25519Proof.P_x,
                    commitment: ethers.keccak256(ethers.toUtf8Bytes(`commitment_${i}`)),
                    blockHeight: 1000000 + i,
                    exists: true
                });
            }
            await wrappedMonero.postMoneroOutputs(outputs);
            console.log("   ✅ Posted 4 outputs to oracle\n");
            
            // Test all 4 real transactions
            for (let i = 0; i < 4; i++) {
                const txData = getRealTransactionProof(i);
                const collateral = calculateRequiredCollateral(txData.tx.amount, xmrPrice);
                const user = i < 2 ? user1 : user2;
                
                console.log(`   💸 TX${i+1}: ${amounts[i]} XMR (${i === 3 ? 'Mainnet' : 'Stagenet'})`);
                
                await wxdai.connect(user).approve(await wrappedMonero.getAddress(), collateral);
                await wrappedMonero.connect(user).mint(
                    txData.proof,
                    txData.publicSignals,
                    txData.dleqProof,
                    txData.ed25519Proof,
                    txData.txHash,
                    user.address
                );
                
                const balance = await wrappedMonero.balanceOf(user.address);
                console.log(`      Minted: ${ethers.formatEther(balance)} zeroXMR`);
                console.log(`      Collateral: ${ethers.formatEther(collateral)} WxDAI`);
            }
            
            const totalSupply = await wrappedMonero.totalSupply();
            const expectedTotal = ethers.parseEther("0.962214529072");
            console.log(`\n   ✅ Total zeroXMR minted on Gnosis: ${ethers.formatEther(totalSupply)}`);
            expect(totalSupply).to.equal(expectedTotal);
        });
    });
    
    describe("Burn Testing with Real Aave", function () {
        it("Should burn zeroXMR and withdraw collateral from Aave", async function () {
            const { wrappedMonero, wxdai, aaveWrapper, user1 } = await loadFixture(deployOnGnosisFixture);
            
            console.log("\n🔥 Testing burn with real Aave V3 integration...");
            
            // First mint some zeroXMR
            const txData = getRealTransactionProof(0);
            const xmrPrice = ethers.parseEther("150");
            const collateral = calculateRequiredCollateral(txData.tx.amount, xmrPrice);
            
            // Post Monero block first
            await wrappedMonero.postMoneroBlock(
                1000000,
                ethers.keccak256(ethers.toUtf8Bytes("block_burn")),
                ethers.parseUnits("7000000", 12)
            );
            
            // Post output to oracle
            await wrappedMonero.postMoneroOutputs([{
                txHash: txData.txHash,
                outputIndex: 0,
                ecdhAmount: ethers.keccak256(ethers.toUtf8Bytes("ecdh_burn")),
                outputPubKey: txData.ed25519Proof.P_x,
                commitment: ethers.keccak256(ethers.toUtf8Bytes("commitment_burn")),
                blockHeight: 1000000,
                exists: true
            }]);
            
            await wxdai.connect(user1).approve(await wrappedMonero.getAddress(), collateral);
            await wrappedMonero.connect(user1).mint(
                txData.proof,
                txData.publicSignals,
                txData.dleqProof,
                txData.ed25519Proof,
                txData.txHash,
                user1.address
            );
            
            const mintedBalance = await wrappedMonero.balanceOf(user1.address);
            console.log(`   Minted: ${ethers.formatEther(mintedBalance)} zeroXMR`);
            console.log(`   Collateral deposited to Aave: ${ethers.formatEther(collateral)} WxDAI`);
            
            // Check Aave wrapper shares
            const wrapperShares = await aaveWrapper.balanceOf(await wrappedMonero.getAddress());
            console.log(`   Aave wrapper shares: ${ethers.formatEther(wrapperShares)}`);
            
            // Get user's WxDAI balance before burn
            const wxdaiBalanceBefore = await wxdai.balanceOf(user1.address);
            
            // Burn half of the zeroXMR
            const burnAmount = mintedBalance / 2n;
            console.log(`\n   Burning ${ethers.formatEther(burnAmount)} zeroXMR...`);
            
            const tx = await wrappedMonero.connect(user1).burn(burnAmount);
            const receipt = await tx.wait();
            
            // Check balances after burn
            const zeroXMRBalanceAfter = await wrappedMonero.balanceOf(user1.address);
            const wxdaiBalanceAfter = await wxdai.balanceOf(user1.address);
            const collateralReturned = wxdaiBalanceAfter - wxdaiBalanceBefore;
            
            console.log(`\n   ✅ Burn successful!`);
            console.log(`   Remaining zeroXMR: ${ethers.formatEther(zeroXMRBalanceAfter)}`);
            console.log(`   Collateral returned from Aave: ${ethers.formatEther(collateralReturned)} WxDAI`);
            console.log(`   Gas used: ${receipt.gasUsed.toString()}`);
            console.log(`   Cost on Gnosis: ~$${(Number(receipt.gasUsed) * 1e-9).toFixed(6)}`);
            
            // Verify correct amounts
            expect(zeroXMRBalanceAfter).to.equal(mintedBalance - burnAmount);
            expect(collateralReturned).to.be.gt(0); // Should get collateral back
            
            console.log(`   ✅ Aave V3 collateral withdrawal verified!`);
        });
    });
    
    describe("Gas Benchmarks on Gnosis", function () {
        it("Should measure real gas costs on Gnosis Chain", async function () {
            const { wrappedMonero, wxdai, deployer, verifier } = await loadFixture(deployOnGnosisFixture);
            
            // Deploy MockSDAI for simpler gas benchmark
            const MockSDAI = await ethers.getContractFactory("MockSDAI");
            const mockSDAI = await MockSDAI.deploy(GNOSIS_WXDAI);
            
            // Deploy separate WrappedMonero for gas benchmark with MockSDAI
            const WrappedMonero = await ethers.getContractFactory("WrappedMonero");
            const benchmarkContract = await WrappedMonero.deploy(
                await verifier.getAddress(),
                GNOSIS_WXDAI,
                await mockSDAI.getAddress(),
                deployer.address,
                deployer.address,
                ethers.parseEther("150")
            );
            
            console.log("\n⛽ Gas Benchmarks on Gnosis Chain:");
            
            // Benchmark: postMoneroBlock
            const blockHeight = 3000000;
            const blockHash = ethers.keccak256(ethers.toUtf8Bytes("block3000000"));
            const totalSupply = ethers.parseEther("18000000"); // ~18M XMR total supply
            const tx1 = await benchmarkContract.connect(deployer).postMoneroBlock(blockHeight, blockHash, totalSupply);
            const receipt1 = await tx1.wait();
            console.log(`   postMoneroBlock: ${receipt1.gasUsed.toString()} gas`);
            
            // Benchmark: updatePrice
            await time.increase(60);
            const tx2 = await benchmarkContract.connect(deployer).updatePrice(ethers.parseEther("160"));
            const receipt2 = await tx2.wait();
            console.log(`   updatePrice: ${receipt2.gasUsed.toString()} gas`);
            
            // Benchmark: mint with fresh mock data
            const mockAmount = 50000000000; // 0.05 XMR in piconero
            const mockTxHash = ethers.keccak256(ethers.toUtf8Bytes("gas_benchmark_tx_12345"));
            const mockProof = new Array(24).fill(1);
            
            const mockDLEQ = {
                c: ethers.keccak256(ethers.toUtf8Bytes("c")),
                s: ethers.keccak256(ethers.toUtf8Bytes("s")),
                K1: ethers.keccak256(ethers.toUtf8Bytes("K1")),
                K2: ethers.keccak256(ethers.toUtf8Bytes("K2"))
            };
            // Use Ed25519 base point G for valid curve points
            const G_x = "15112221349535400772501151409588531511454012693041857206046113283949847762202";
            const G_y = "46316835694926478169428394003475163141307993866256225615783033603165251855960";
            
            const mockEd25519 = {
                R_x: ethers.zeroPadValue(ethers.toBeHex(G_x), 32),
                R_y: ethers.zeroPadValue(ethers.toBeHex(G_y), 32),
                S_x: ethers.zeroPadValue(ethers.toBeHex(G_x), 32),
                S_y: ethers.zeroPadValue(ethers.toBeHex(G_y), 32),
                P_x: ethers.zeroPadValue(ethers.toBeHex(G_x), 32),
                P_y: ethers.zeroPadValue(ethers.toBeHex(G_y), 32),
                B_x: ethers.zeroPadValue(ethers.toBeHex(G_x), 32),  // B = G
                B_y: ethers.zeroPadValue(ethers.toBeHex(G_y), 32),
                H_s: ethers.zeroPadValue(ethers.toBeHex("0"), 32),  // H_s = 0, so P = 0·G + B = B = G ✓
                A: ethers.keccak256(ethers.toUtf8Bytes("A"))
            };
            
            // Public signals must match Ed25519 proof (Security Fix #1: Proof Binding)
            const mockPublicSignals = new Array(70).fill(0);
            mockPublicSignals[0] = mockAmount;
            mockPublicSignals[1] = mockEd25519.R_x;  // Already bytes32, ethers will convert
            mockPublicSignals[2] = mockEd25519.R_y;
            mockPublicSignals[3] = mockEd25519.S_x;
            mockPublicSignals[4] = mockEd25519.S_y;
            mockPublicSignals[5] = mockEd25519.P_x;
            mockPublicSignals[6] = mockEd25519.P_y;
            
            // Block 3000000 already posted above for gas benchmark
            // Post output to oracle
            await benchmarkContract.postMoneroOutputs([{
                txHash: mockTxHash,
                outputIndex: 0,
                ecdhAmount: ethers.keccak256(ethers.toUtf8Bytes("ecdh_gas")),
                outputPubKey: mockEd25519.P_x,
                commitment: ethers.keccak256(ethers.toUtf8Bytes("commitment_gas")),
                blockHeight: 3000000,
                exists: true
            }]);
            
            const collateral = calculateRequiredCollateral(mockAmount, ethers.parseEther("150"));
            await wxdai.connect(deployer).approve(await benchmarkContract.getAddress(), collateral);
            
            try {
                const tx3 = await benchmarkContract.connect(deployer).mint(
                    mockProof,
                    mockPublicSignals,
                    mockDLEQ,
                    mockEd25519,
                    mockTxHash,
                    deployer.address,
                    { gasLimit: 10000000 } // Explicit gas limit
                );
                const receipt3 = await tx3.wait();
                console.log(`   mint: ${receipt3.gasUsed.toString()} gas`);
            } catch (error) {
                console.log("\n❌ Mint failed with error:");
                console.log("Error message:", error.message);
                console.log("\nPublic signals[0-6]:", mockPublicSignals.slice(0, 7));
                console.log("\nEd25519 proof R_x:", mockEd25519.R_x);
                throw error;
            }
            
            console.log("\n   ✅ Gnosis Chain gas costs are ~5-10x cheaper than Ethereum mainnet!");
        });
        
        it("Should post real Monero block data from RPC node", async function () {
            this.timeout(30000); // Allow time for RPC calls
            
            const { wrappedMonero, deployer } = await loadFixture(deployOnGnosisFixture);
            
            console.log("\n🔗 Fetching real Monero blockchain data...");
            
            // Get latest block
            const latestHeight = await getLatestBlockHeight();
            console.log(`   Latest Monero block: ${latestHeight}`);
            
            // Fetch a recent block (go back 100 blocks for stability)
            const targetHeight = latestHeight - 100;
            const blockData = await getMoneroBlockData(targetHeight);
            
            console.log(`\n📦 Real Monero Block Data:`);
            console.log(`   Height: ${blockData.height}`);
            console.log(`   Hash: ${blockData.hash}`);
            console.log(`   Timestamp: ${new Date(blockData.timestamp * 1000).toISOString()}`);
            console.log(`   Transactions: ${blockData.txCount}`);
            console.log(`   Estimated Supply: ${(blockData.totalSupply / 1e12).toFixed(2)} XMR`);
            
            // Post to contract
            const totalSupplyWei = ethers.parseUnits(blockData.totalSupply.toString(), 0);
            const tx = await wrappedMonero.connect(deployer).postMoneroBlock(
                blockData.height,
                blockData.hash,
                totalSupplyWei
            );
            const receipt = await tx.wait();
            
            console.log(`\n✅ Posted real Monero block to contract!`);
            console.log(`   Gas used: ${receipt.gasUsed.toString()}`);
            console.log(`   Cost on Gnosis: ~$${(Number(receipt.gasUsed) * 1e-9).toFixed(6)}`);
            console.log(`   ✅ Real Monero blockchain data successfully integrated!`);
        });
    });
});
