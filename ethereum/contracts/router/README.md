# Co-LP Router Implementation

## Overview

The `wsXMRLiquidityRouter` enables sDAI liquidity providers (LPs) and wsXMR holders (users) to pool capital together into Uniswap V3 positions with:

- **Dual-approval matchmaking**: Both LP and user must approve each other
- **Fee splitting**: sDAI fees to LP, wsXMR fees to user
- **IL compensation**: Automatic impermanent loss tracking and compensation
- **Burn from internal balance**: Users can burn wsXMR directly from router balance

## Architecture

### Oracle Integration

The router reads prices from `SimpleOracleFacet` which is updated off-chain by a bot every ~5 minutes:
- **No on-chain price updates needed** (legacy Pyth integration removed)
- `oracleUpdateData` parameters kept for forward compatibility but ignored
- Any ETH sent for "updates" is refunded to `pendingETHRefunds`
- Prices revert with `StalePrice()` if older than 2 minutes

### Uniswap V3 on Gnosis

Uses official Uniswap V3 deployment on Gnosis Chain:
- Factory: `0xe32F7dD7e3f098D518ff19A22d5f028e076489B1`
- Position Manager: `0xAE8fbE656a77519a7490054274910129c9244FA3`
- Pool Fee: 0.3% (3000 bps)
- Tick Spacing: 60

## Testing

### Local Fork Testing

Test against Gnosis mainnet fork using Hardhat:

```bash
# Install dependencies
npm install

# Run tests (automatically forks Gnosis mainnet)
npx hardhat test test/08-CoLPRouter.test.js --network hardhat

# Run with verbose output
npx hardhat test test/08-CoLPRouter.test.js --network hardhat --verbose
```

The test suite:
1. Forks Gnosis mainnet at recent block
2. Uses deployed wsXmrHub (`0xB00fed5E2F06187369f5bbF2fcFF065FA188D1a5`)
3. Uses deployed wsXMR token (`0x4206580496249266945A5aED42E41b6CE9cd8DAD`)
4. Impersonates sDAI whale to fund test accounts
5. Tests all router functionality end-to-end

### Test Coverage

- ✅ Deposit/withdrawal (LP sDAI, user wsXMR)
- ✅ Dual approval matrix with nonce bumping
- ✅ Pool initialization with oracle prices
- ✅ Position creation with approvals
- ✅ Position closing with IL compensation
- ✅ Fee collection and withdrawal
- ✅ Burn from internal balance
- ✅ MIN_POSITION_DURATION enforcement
- ✅ MAX_ACTIVE_POSITIONS_PER_USER limits
- ✅ Oracle staleness handling
- ✅ ETH refunds

## Deployment

### Prerequisites

```bash
# Set environment variables
export PRIVATE_KEY="0x..."
export GNOSIS_RPC_URL="https://rpc.gnosischain.com"
export GNOSISSCAN_API_KEY="..."  # For verification
```

### Deploy Router

```bash
# Deploy and register with hub
forge script script/DeployRouter.s.sol:DeployRouter \
  --rpc-url $GNOSIS_RPC_URL \
  --broadcast \
  --verify

# Or dry-run first
forge script script/DeployRouter.s.sol:DeployRouter \
  --rpc-url $GNOSIS_RPC_URL
```

### Initialize Pool

```bash
# Set router address
export ROUTER_ADDRESS="0x..."

# Initialize Uniswap V3 pool
forge script script/DeployRouter.s.sol:InitializePool \
  --rpc-url $GNOSIS_RPC_URL \
  --broadcast
```

### Verify Deployment

```bash
# Check configuration
forge script script/DeployRouter.s.sol:VerifyDeployment \
  --rpc-url $GNOSIS_RPC_URL
```

## Usage Flow

### For LPs

1. **Allocate sDAI**
   ```solidity
   sDAI.approve(router, amount);
   router.allocateLiquidity(amount);
   ```

2. **Approve user**
   ```solidity
   router.increaseUserApproval(userAddress, sDAIAmount);
   ```

3. **Create position** (after user approves)
   ```solidity
   router.createPosition(lpAddress, userAddress, sDAIAmount, wsxmrAmount, deadline);
   ```

4. **Collect fees**
   ```solidity
   router.collectFees(positionIndex);
   router.withdrawFees();
   ```

5. **Close position** (after MIN_POSITION_DURATION)
   ```solidity
   router.closePosition(positionIndex, deadline, minTotalValueUSD);
   ```

### For Users

1. **Deposit wsXMR**
   ```solidity
   wsxmr.approve(router, amount);
   router.depositWsxmr(amount);
   ```

2. **Approve LP**
   ```solidity
   router.increaseLpApproval(lpAddress, wsxmrAmount);
   ```

3. **Burn from internal balance** (optional)
   ```solidity
   router.burnFromInternalBalance(wsxmrAmount, lpVault);
   ```

## Security Considerations

### Dual Approval Required

Both LP and user must approve each other before position creation:
- `lpApprovalAmount[lp][user] >= sDAIAmount`
- `userApprovalAmount[user][lp] >= wsxmrAmount`
- Approvals decremented on position creation
- Nonce bumped on every approval change (anti-front-running)

### Position Constraints

- `MIN_DEPOSIT_AMOUNT = 1e6` (dust prevention)
- `MIN_POSITION_DURATION = 1 hour` (anti-MEV)
- `MAX_ACTIVE_POSITIONS_PER_USER = 50` (gas limits)

### IL Compensation

When closing a position:
1. Calculate final USD value for each side
2. Compare to initial USD value
3. Compensate losing side from returned tokens
4. Credit compensation to `pendingILSDAI` or `pendingILWsxmr`

### Oracle Dependency

Router reads prices from hub's oracle facet:
- Prices must be < 2 minutes old
- Reverts with `StalePrice()` if stale
- No on-chain update mechanism (bot pushes prices)

## Contract Size

Current size: ~23KB (under 24KB limit)

If approaching limit:
- Factor IL logic into library (similar to `CollateralLogic`)
- Optimize storage layout
- Remove redundant checks

## Frontend Integration

Recommended UI flow:
1. Show LP available liquidity and user available wsXMR
2. Display approval status for both sides
3. Show active positions with real-time P&L
4. Display pending fees and IL credits
5. Link to Oku.trade for pool analytics (Uniswap V3 on Gnosis)

## Known Limitations

1. **No UniversalRouter**: Gnosis Uniswap V3 doesn't have UniversalRouter - use Position Manager directly
2. **No Permit2**: Standard `approve`/`transferFrom` required
3. **Oracle bot dependency**: Prices must be pushed every ~5 min or positions fail
4. **Full-range positions only**: Uses MIN_TICK to MAX_TICK (can be optimized later)

## Mainnet Addresses

- **Hub**: `0xB00fed5E2F06187369f5bbF2fcFF065FA188D1a5`
- **wsXMR**: `0x4206580496249266945A5aED42E41b6CE9cd8DAD`
- **sDAI**: `0xaf204776c7245bF4147c2612BF6e5972Ee483701`
- **Uniswap V3 Factory**: `0xe32F7dD7e3f098D518ff19A22d5f028e076489B1`
- **Uniswap V3 Position Manager**: `0xAE8fbE656a77519a7490054274910129c9244FA3`

## Support

For issues or questions:
1. Check test suite for usage examples
2. Review deployment script for configuration
3. Verify oracle bot is running and pushing prices
4. Check Gnosisscan for transaction details
