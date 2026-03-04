# WrapSynth Comprehensive Test Suite

This test suite provides comprehensive coverage for the WrapSynth protocol contracts on Gnosis Chain fork.

## Test Structure

### 1. Token Authority Tests (`01-TokenAuthority.test.js`)
Tests wsXMR token minting and burning permissions.

**A. VaultManager Successfully Calls Mint and Burn**
- ✅ Verifies VaultManager is authorized to mint wsXMR
- ✅ Verifies VaultManager is authorized to burn wsXMR

**B. Arbitrary External Address Attempts Mint/Burn**
- ✅ Reverts when unauthorized address tries to mint
- ✅ Reverts when unauthorized address tries to burn
- ✅ Reverts even if caller is contract owner

### 2. Vault Management Tests (`02-VaultManagement.test.js`)
Tests vault creation, collateral deposits, and withdrawals.

**A. User Deposits DAI into Active Vault**
- Creates vault with sDAI collateral
- Deposits DAI and automatically converts to sDAI
- Tracks lpPrincipalDeposits correctly
- Increments globalLpPrincipal

**B. User Deposits Native Asset into ERC20 Vault**
- Reverts when depositing ETH to sDAI vault
- Validates msg.value matches amount

**A. LP Requests Withdrawal of Unlocked Active Collateral**
- Allows withdrawal while maintaining 150% health ratio
- Allows full withdrawal when vault has no debt
- Decrements principal proportionally

**B. LP Attempts to Withdraw Locked Collateral**
- Reverts when trying to withdraw more than available
- Correctly calculates available collateral (total - locked)

### 3. Minting Lifecycle Tests (`03-MintingLifecycle.test.js`)
Tests the complete minting flow and anti-spam mechanisms.

**A. User Provides Exact ETH Griefing Deposit**
- Initiates mint with exact griefing deposit
- Increments vault pendingDebt
- LP sets mint ready

**B. User Provides Insufficient ETH for Griefing Deposit**
- Reverts with InsufficientDeposit error
- Reverts with zero deposit when LP requires deposit

**A. User Fails to Lock XMR Before Timeout**
- Allows third party to cancel after timeout
- Awards deposit to LP
- Releases pendingDebt

**B. LP Confirms READY but Fails to Finalize**
- Refunds deposit to user after extended timeout
- Permissionless cleanup mechanism

**A. User Requests Mint Within LP's maxMintBps Capacity**
- Accepts mint request within capacity limits

**B. User Requests Mint Exceeding LP Available Bandwidth**
- Reverts when mint exceeds maxMintBps

### 4. Burning Lifecycle Tests (`04-BurningLifecycle.test.js`)
Tests the 4-step burn process and slashing mechanics.

**A. Full 4-Step Burn Completes Successfully**
- User burns wsXMR
- LP proposes hash
- User confirms Monero lock
- LP reveals secret to unlock collateral

**B. LP Proposes Hash but Fails to Reveal Secret**
- User claims slashed collateral after deadline
- Penalty mechanism for LP failure

**A. User Requests Burn but Abandons**
- LP cancels after timeout
- Restores vault debt and collateral

**B. User Routes Burn to Vault with Health < 150%**
- Reverts with InsufficientCollateral error
- Prevents burns to unhealthy vaults

### 5. Liquidation Tests (`05-Liquidation.test.js`)
Tests liquidation engine and bad debt handling.

**A. Liquidate Vault at 115% Health Ratio**
- Successfully liquidates underwater vault
- Liquidator receives 10% bonus

**B. Attempt to Liquidate Healthy Vault at 121%**
- Reverts with VaultHealthy error

**A. Severely Underwater Vault Liquidation**
- Scales down debt to maintain 10% bonus
- Leaves fractional bad debt behind

**B. Completely Drained Vault Cleanup**
- Emits BadDebtWrittenOff event
- Updates globalTotalDebt
- Does not burn tokens from address(this)

### 6. Buy-and-Burn Tests (`06-BuyAndBurn.test.js`)
Tests protocol market defense mechanisms.

**A. Trigger Buy-and-Burn When XMR Dips 1% Below EMA**
- Executes buy-and-burn successfully
- Deploys 20% of war chest per execution
- Updates globalDebtIndex proportionally

**B. Attempt Trigger During Cooldown or Above Threshold**
- Reverts during 24-hour cooldown
- Reverts when spot price >= EMA * 0.99
- Reverts when war chest is empty

**A. Buy-and-Burn with MEV Protection**
- Calculates minimum output using oracle
- Limits maximum slippage to 2%
- Uses Pyth oracle for sDAI price

**B. Pyth Oracle High Uncertainty Rejection**
- Reverts with StalePrice when confidence > 10%
- Accepts prices with confidence <= 10%

**A. Yield Skimming Calculation**
- Skims yield in O(1) complexity
- Calculates yield as (totalValue - principal - warChest)
- Does not reduce LP collateralAmount

**B. Burn wsXMR and Update Global Debt Index**
- Proportionally reduces debt across all vaults
- Prevents globalDebtIndex from reaching zero
- Caps reduction at 99.9999%

### 7. Router Tests (`07-RouterTests.test.js`)
Tests liquidity router matchmaking and position management.

**A. LP and User Mutually Approve and Create Position**
- Creates Uniswap V3 position with mutual consent
- Both parties must approve each other

**B. LP Approves but User Doesn't Approve LP**
- Reverts without mutual consent
- Enforces dual approval system

**A. Router Validates Collateral Bounds Match Oracle**
- Creates position when prices align with oracle
- Oracle-based price validation

**B. Flash Loan Pool Manipulation Detection**
- Reverts on >10% spot divergence from oracle
- Prevents MEV attacks

**A. Position Closed with Price Divergence**
- Distributes based on original USD value
- Both parties receive proportional share of both assets

**B. Unauthorized Position Close Attempt**
- Reverts with Unauthorized error
- Only LP or User can close their position

**A. Position Accumulates Trading Fees**
- Splits fees 50/50 between LP and User
- Tracks pendingSDAIFees and pendingWsxmrFees

**B. LP Attempts to Deallocate Active Liquidity**
- Reverts due to insufficient idle balance
- Only allows deallocation of non-position liquidity

## Running Tests

### Run All Tests with Gnosis Fork
```bash
FORK_GNOSIS=true npx hardhat test
```

### Run Specific Test File
```bash
FORK_GNOSIS=true npx hardhat test test/01-TokenAuthority.test.js
```

### Run Tests Without Fork (Local Network)
```bash
npx hardhat test
```

### Use the Test Script
```bash
./test-gnosis.sh
```

## Test Helpers

Located in `test/helpers/testHelpers.js`:

- `getXDAI(recipient, amount)` - Get xDAI from whale for testing
- `generateSecret()` - Generate secp256k1 secret and commitment
- `setupVaultWithCollateral(vaultManager, lp, daiAmount)` - Setup LP vault
- `createMintRequest(...)` - Create a mint request
- `calculateCollateralForDebt(...)` - Calculate required collateral
- `increaseTime(seconds)` - Time travel helper

## Configuration

The test suite uses Gnosis Chain fork configuration from `hardhat.config.js`:

```javascript
hardhat: {
  chainId: 31337,
  forking: {
    url: process.env.GNOSIS_RPC_URL || "https://rpc.gnosischain.com",
    enabled: process.env.FORK_GNOSIS === "true",
  },
}
```

## Gnosis Chain Addresses

All mainnet addresses are defined in `test/helpers/testHelpers.js`:

- **sDAI**: `0xaf204776c7245bF4147c2612BF6e5972Ee483701`
- **xDAI**: `0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d`
- **Pyth Oracle**: `0x2880aB155794e7179c9eE2e38200202908C17B43`
- **Uniswap V3 Position Manager**: `0xC36442b4a4522E871399CD717aBDD847Ab11FE88`
- **Uniswap V3 Router**: `0xE592427A0AEce92De3Edee1F18E0157C05861564`

## Test Coverage Summary

| Category | Tests | Status |
|----------|-------|--------|
| Token Authority | 5 | ✅ Passing |
| Vault Management | 8 | ⚠️ Needs fixes |
| Minting Lifecycle | 8 | ⚠️ Needs fixes |
| Burning Lifecycle | 4 | 🚧 Requires secp256k1 |
| Liquidation | 6 | 🚧 Requires price oracle |
| Buy-and-Burn | 10 | 🚧 Requires yield setup |
| Router | 10 | 🚧 Requires liquidity |

## Known Issues

1. **xDAI Whale Impersonation**: Some tests fail when trying to get xDAI from Balancer Vault. May need different whale address.

2. **Secp256k1 Implementation**: Full mint/burn flow tests require proper secp256k1 secret generation and verification.

3. **Price Oracle Mocking**: Liquidation and buy-and-burn tests require mocking Pyth oracle responses.

4. **Uniswap Liquidity**: Router tests require actual Uniswap V3 pool with liquidity.

## Next Steps

1. Fix xDAI acquisition in test helpers
2. Implement proper secp256k1 test utilities
3. Add Pyth oracle mocking for price manipulation tests
4. Create Uniswap pool setup for router tests
5. Add gas usage reporting
6. Add coverage reporting

## Notes

- Tests use `this.skip()` for scenarios requiring complex setup
- All tests are designed to run on Gnosis Chain fork
- Test suite follows the exact scenarios from the specification
- Each test category is isolated in its own file for clarity
