# Storage Architecture Analysis

## Current Architecture

The current implementation uses a **shared storage pattern** where:
- `wsXmrStorage` contract defines all state variables
- All facets inherit from `wsXmrStorage`
- Each facet has its own copy of the storage layout in memory
- The Hub contract also inherits from `wsXmrStorage`

### How It Works
```solidity
contract wsXmrStorage {
    // All state variables defined here
    mapping(address => Vault) public vaults;
    uint256 public globalTotalDebt;
    // ...
}

contract VaultFacet is wsXmrStorage {
    // Accesses storage directly via inheritance
}

contract wsXmrHub is wsXmrStorage {
    // Owns the actual storage
}
```

## Current Issues

### 1. Storage Duplication Concern
Each facet contract has the full storage layout compiled into it, even though only the Hub contract actually stores the data. This is **not a runtime issue** but increases deployment bytecode size.

### 2. No Diamond Storage Pattern
The current architecture doesn't use the Diamond Storage pattern (EIP-2535), which would:
- Use `struct` storage at specific slots
- Allow facets to have independent storage
- Enable more flexible upgrades

### 3. Immutables Duplication
Each facet defines the same immutables:
```solidity
address public immutable wsxmrToken;
address public immutable deployer;
address public immutable verifierProxy;
```

These are set in each facet's constructor, duplicating the values across contracts.

## Potential Improvements

### Option 1: Diamond Storage Pattern (EIP-2535)
**Pros:**
- Industry standard for upgradeable contracts
- Each facet can have independent storage
- Better upgrade flexibility
- Smaller facet bytecode

**Cons:**
- Requires significant refactoring
- More complex storage access patterns
- Need to use `LibDiamond` or similar

**Example:**
```solidity
library LibVaultStorage {
    bytes32 constant VAULT_STORAGE_POSITION = keccak256("wsxmr.storage.vault");
    
    struct VaultStorage {
        mapping(address => Vault) vaults;
        address[] vaultList;
    }
    
    function vaultStorage() internal pure returns (VaultStorage storage vs) {
        bytes32 position = VAULT_STORAGE_POSITION;
        assembly {
            vs.slot := position
        }
    }
}

contract VaultFacet {
    function getVault(address lp) external view returns (Vault memory) {
        return LibVaultStorage.vaultStorage().vaults[lp];
    }
}
```

### Option 2: Proxy with Delegatecall (Current Approach)
**Pros:**
- Simpler than Diamond
- All storage in one contract
- Direct storage access

**Cons:**
- Larger facet bytecode
- Must maintain strict storage layout
- Harder to add new storage variables

### Option 3: Hybrid Approach
Keep current architecture but optimize:

1. **Move immutables to Hub only**
   ```solidity
   contract VaultFacet {
       function _hub() internal view returns (IwsXmrHub) {
           return IwsXmrHub(address(this));
       }
       
       function _wsxmrToken() internal view returns (address) {
           return _hub().wsxmrToken();
       }
   }
   ```

2. **Split storage by domain**
   ```solidity
   contract VaultStorage {
       mapping(address => Vault) public vaults;
       address[] public vaultList;
   }
   
   contract MintStorage {
       mapping(bytes32 => MintRequest) public mintRequests;
       mapping(address => bytes32[]) public userMintRequests;
   }
   ```

3. **Use storage libraries for common patterns**
   ```solidity
   library StorageAccess {
       function getVault(address lp) internal view returns (Vault storage) {
           return wsXmrStorage(address(this)).vaults(lp);
       }
   }
   ```

## Recommendation

### Short Term (Current State)
The current architecture is **functional and safe** for production. The main issues are:
1. Larger deployment costs due to duplicated storage layout
2. Need to be careful with storage layout changes

**Action Items:**
- Document storage layout clearly
- Add storage gap for future upgrades
- Consider storage layout tests

### Long Term (Future Upgrade)
Consider migrating to **Diamond Storage Pattern** if:
- Need to add significant new features
- Want to reduce deployment costs
- Need more flexible upgrade paths

**Migration Path:**
1. Create storage libraries for each domain
2. Gradually migrate facets to use libraries
3. Test extensively with storage layout verification
4. Deploy new version with migration script

## Storage Layout Safety

### Current Protections
```solidity
/**
 * CRITICAL: Storage layout must NEVER be modified after deployment
 * Only append new variables at the end to maintain upgrade compatibility
 */
```

### Recommended Additions
```solidity
contract wsXmrStorage {
    // ... existing storage ...
    
    // Storage gap for future upgrades (50 slots)
    uint256[50] private __gap;
}
```

### Storage Layout Testing
```solidity
// test/StorageLayout.t.sol
contract StorageLayoutTest is Test {
    function testStorageLayout() public {
        // Verify storage slots match expected layout
        // Use foundry's storage inspection tools
    }
}
```

## Facet Communication

### Current Pattern
Facets call each other through the Hub:
```solidity
// In BurnFacet
IOracleFacet(oracleFacet).getXmrPrice();
```

### Issue
This requires storing facet addresses in storage and keeping them updated.

### Alternative Pattern
```solidity
// Use Hub as router
IOracleFacet(IwsXmrHub(address(this)).oracleFacet()).getXmrPrice();
```

This is more gas-intensive but more flexible for upgrades.

## Conclusion

The current storage architecture is **adequate for production** but has room for optimization. The main priorities should be:

1. **Document storage layout** - Critical for maintenance
2. **Add storage gaps** - Enables future upgrades
3. **Test storage layout** - Prevents upgrade issues
4. **Consider Diamond pattern** - For future major upgrades

The architecture does NOT need immediate changes but should be monitored as the system evolves.
