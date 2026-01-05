# WrappedMonero Testing Guide

## Overview

Comprehensive test suite for the WrappedMonero (zeroXMR) contract with Arbitrum mainnet fork testing.

## Setup

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment

Create `.env` file:

```bash
# Arbitrum RPC URL (for forking)
ARBITRUM_RPC_URL=https://arb1.arbitrum.io/rpc

# Or use Alchemy/Infura
# ARBITRUM_RPC_URL=https://arb-mainnet.g.alchemy.com/v2/YOUR_API_KEY

# Enable forking
FORK=true
```

## Running Tests

### Run All Tests

```bash
npx hardhat test
```

### Run Specific Test File

```bash
npx hardhat test test/WrappedMonero.test.js
```

### Run with Arbitrum Fork

```bash
FORK=true npx hardhat test
```

### Run with Gas Reporting

```bash
REPORT_GAS=true npx hardhat test
```

### Run with Coverage

```bash
npx hardhat coverage
```

## Test Structure

### 1. Deployment Tests
- ✅ Verify initial values (name, symbol, oracle, guardian)
- ✅ Verify constants (collateral ratios, liquidation parameters)

### 2. Oracle Functions
- ✅ Post Monero block data
- ✅ Reject duplicate blocks
- ✅ Reject non-increasing block heights
- ✅ Update TWAP price
- ✅ Enforce price update frequency (1 minute minimum)
- ✅ Transfer oracle role (one-time)

### 3. Minting
- ✅ Mint zeroXMR with correct collateral (150%)
- ✅ Verify PLONK proof
- ✅ Verify DLEQ proof
- ✅ Prevent double-spending
- ✅ Reject invalid proofs
- ✅ Reject minting when paused

### 4. Burning
- ✅ Burn zeroXMR and return proportional collateral
- ✅ Reject burning more than balance

### 5. Liquidation
- ✅ Liquidate when collateral ratio < 120%
- ✅ Reward liquidator 5%
- ✅ Send 95% to treasury
- ✅ Reject liquidation when ratio >= 120%
- ✅ Calculate collateral ratio correctly

### 6. Guardian Functions
- ✅ Pause minting (emergency)
- ✅ Enforce 30-day unpause timelock
- ✅ Reject non-guardian actions

### 7. View Functions
- ✅ Get Monero block data
- ✅ Check if output is spent
- ✅ Get total collateral value
- ✅ Get collateral ratio

### 8. Edge Cases
- ✅ Handle zero price
- ✅ Handle maximum uint256 amounts
- ✅ Handle rapid price changes (TWAP smoothing)

## Test Scenarios

### Scenario 1: Happy Path Mint

```javascript
// 1. User has 1 XMR Monero transaction
// 2. Generates PLONK + DLEQ proofs
// 3. Deposits $225 DAI collateral (150% of $150 XMR)
// 4. Receives 1 zeroXMR
// 5. Collateral deposited in sDAI (earning yield)
```

### Scenario 2: Price Drop → Liquidation

```javascript
// 1. User mints 1 zeroXMR with $225 collateral (150%)
// 2. XMR price drops from $150 to $100
// 3. Collateral ratio = $225 / $100 = 225% (still safe)
// 4. XMR price drops to $180
// 5. Collateral ratio = $225 / $180 = 125% (still safe)
// 6. XMR price drops to $190
// 7. Collateral ratio = $225 / $190 = 118% (< 120% threshold!)
// 8. Liquidator calls liquidate()
// 9. 10% of position liquidated
// 10. Liquidator receives 5% reward
// 11. 95% goes to treasury
```

### Scenario 3: Guardian Pause

```javascript
// 1. Circuit bug discovered
// 2. Guardian calls pauseMinting()
// 3. All mints blocked immediately
// 4. Existing holders can still burn
// 5. After 30 days, guardian can unpause
```

## Mock Contracts

### MockPlonkVerifier
- Always returns `true` for testing
- Can be toggled with `setShouldPass(false)` to test failures

### MockSDAI
- Simplified ERC4626 vault
- 1:1 share:asset ratio (no yield for simplicity)
- Implements: `deposit()`, `redeem()`, `convertToAssets()`

## Arbitrum Fork Testing

### Why Fork Arbitrum?

1. **Real DAI contract** - Test with actual DAI token
2. **Gas costs** - Accurate gas estimates for Arbitrum
3. **Integration** - Test with real DeFi protocols
4. **Whale accounts** - Impersonate DAI whales for funding

### Fork Configuration

```javascript
// hardhat.config.js
networks: {
  hardhat: {
    forking: {
      url: process.env.ARBITRUM_RPC_URL,
      enabled: process.env.FORK === "true"
    }
  }
}
```

### Impersonating Accounts

```javascript
const DAI_WHALE = "0x..."; // Large DAI holder on Arbitrum
await helpers.impersonateAccount(DAI_WHALE);
const whale = await ethers.getSigner(DAI_WHALE);
await dai.connect(whale).transfer(user.address, amount);
```

## Gas Optimization Tests

### Target Gas Costs

| Function | Target Gas | Notes |
|----------|-----------|-------|
| `mint()` | < 500k | Includes PLONK + DLEQ verification |
| `burn()` | < 100k | Simple burn + transfer |
| `liquidate()` | < 150k | Liquidation logic |
| `postMoneroBlock()` | < 50k | Oracle update |
| `updatePrice()` | < 30k | TWAP calculation |

## Security Checklist

- [ ] Reentrancy protection (ReentrancyGuard)
- [ ] Pausable minting (Guardian)
- [ ] Double-spending prevention (usedOutputs mapping)
- [ ] Collateral ratio enforcement (150% initial, 120% liquidation)
- [ ] TWAP price manipulation resistance (15-minute smoothing)
- [ ] Oracle access control (onlyOracle modifier)
- [ ] Guardian access control (onlyGuardian modifier)
- [ ] Timelock on unpause (30 days)
- [ ] Integer overflow protection (Solidity 0.8.20)
- [ ] Zero address checks
- [ ] Zero amount checks

## Common Issues

### Issue: "Transfer failed"
**Solution:** Ensure user has sufficient DAI and has approved the contract

### Issue: "PLONK verification failed"
**Solution:** Check that MockPlonkVerifier.shouldPass is true

### Issue: "Not liquidatable"
**Solution:** Ensure collateral ratio is actually < 120%

### Issue: "Timelock not expired"
**Solution:** Fast forward time with `await time.increase(30 * 24 * 60 * 60)`

## Next Steps

1. **Add real PLONK verifier** - Replace mock with actual PlonkVerifier.sol
2. **Add real DLEQ verification** - Implement full Ed25519 DLEQ proof checking
3. **Add Uniswap TWAP** - Replace oracle with Uniswap V3 TWAP
4. **Add multi-oracle consensus** - N-of-M oracle voting
5. **Add liquidation bot** - Automated liquidation monitoring
6. **Add yield distribution** - Distribute sDAI yield to LPs
7. **Security audit** - Trail of Bits / OpenZeppelin

## Resources

- [SYNTHWRAP.md](../SYNTHWRAP.md) - Full specification
- [Hardhat Docs](https://hardhat.org/docs)
- [OpenZeppelin Contracts](https://docs.openzeppelin.com/contracts)
- [Arbitrum Docs](https://docs.arbitrum.io/)
