# wsXMRLiquidityRouter Refactoring Plan

## Current Status
The `wsXMRLiquidityRouter.sol.SKIP` file contains the old router implementation that was designed to work with the monolithic `VaultManager` contract. It needs to be refactored to work with the new Hub + Facets architecture.

## Key Changes Needed

### 1. Replace VaultManager References with Hub
**Current:**
```solidity
VaultManager public immutable vaultManager;
```

**Should be:**
```solidity
IwsXmrHub public immutable hub;
```

### 2. Update Constructor
**Current:**
```solidity
constructor(
    address payable _vaultManager,
    address _wsxmrToken,
    address _positionManager,
    address _uniswapFactory
)
```

**Should be:**
```solidity
constructor(
    address _hub,
    address _positionManager,
    address _uniswapFactory
)
```

The wsxmrToken can be retrieved from the hub.

### 3. Update Vault Health Checks
**Current:**
```solidity
try vaultManager.getVaultHealth(msg.sender) returns (uint256 ratio) {
    require(ratio >= 150, "Vault undercollateralized");
}
```

**Should be:**
```solidity
try IVaultFacet(hub.vaultFacet()).getVaultHealth(msg.sender) returns (uint256 ratio) {
    require(ratio >= 150, "Vault undercollateralized");
}
```

### 4. Update Price Oracle Calls
**Current:**
```solidity
vaultManager.updatePrices{value: msg.value}(_reports);
uint256 sDAIPrice = vaultManager.getCollateralPriceWithAge(30 seconds);
uint256 wsxmrPrice = vaultManager.getXmrPriceWithAge(30 seconds);
```

**Should be:**
```solidity
IOracleFacet(hub.oracleFacet()).updatePrices{value: msg.value}(_reports);
uint256 sDAIPrice = IOracleFacet(hub.oracleFacet()).getCollateralPrice();
uint256 wsxmrPrice = IOracleFacet(hub.oracleFacet()).getXmrPrice();
```

### 5. Update Burn Request Calls
**Current:**
```solidity
requestId = vaultManager.requestBurnFromRouter(_wsxmrAmount, _lpVault, msg.sender);
```

**Should be:**
```solidity
requestId = IBurnFacet(hub.burnFacet()).requestBurnFromRouter(_wsxmrAmount, _lpVault, msg.sender);
```

### 6. Update Vault Data Access
**Current:**
```solidity
(address lpAddress,,,,,,,,,,,,) = vaultManager.vaults(_lpVault);
```

**Should be:**
```solidity
(address lpAddress,,,,,,,,,,,,) = IVaultFacet(hub.vaultFacet()).getVault(_lpVault);
```

Or use the public mapping directly if available through the hub.

### 7. Token Burning
**Current:**
```solidity
wsxmrToken.burn(address(this), _wsxmrAmount);
```

**Should be:**
```solidity
IwsXmrHub(hub).burnTokens(address(this), _wsxmrAmount);
```

## Implementation Steps

1. **Create new file**: `wsXMRLiquidityRouter.sol` (remove .SKIP extension)
2. **Update imports**: Add Hub and Facet interface imports
3. **Refactor constructor**: Accept hub address instead of vaultManager
4. **Update all function calls**: Replace vaultManager calls with appropriate facet calls
5. **Test integration**: Ensure router works with new architecture
6. **Update deployment scripts**: Deploy router with hub address

## Interface Requirements

The router will need to import:
- `IwsXmrHub` - For core hub operations
- `IVaultFacet` - For vault queries
- `IOracleFacet` - For price feeds
- `IBurnFacet` - For burn requests
- `IMintFacet` - If needed for mint operations

## Deployment Considerations

1. Router must be registered with the hub via `setLiquidityRouter()`
2. Router needs to be added to the facets whitelist if there's access control
3. Update any existing deployment scripts to use new constructor signature

## Testing Checklist

- [ ] Pool initialization with oracle prices
- [ ] LP liquidity allocation/deallocation
- [ ] User wsXMR deposits/withdrawals
- [ ] Position creation with mutual approvals
- [ ] Position closing with IL handling
- [ ] Fee collection and distribution
- [ ] Burn from internal balance
- [ ] ETH refund withdrawals
