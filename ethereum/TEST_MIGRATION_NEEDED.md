# Test Migration Required

The existing tests in `test/VaultManager.t.sol` and `test/VaultManagerFork.t.sol` need to be updated to work with the new Hub + Facets architecture.

## What Changed

**Old Architecture:**
- Single `VaultManager` contract
- Direct calls to `vaultManager.updatePrices()`, `vaultManager.createVault()`, etc.

**New Architecture:**
- `wsXmrHub` (central coordinator)
- 6 Facets: OracleFacet, VaultFacet, MintFacet, BurnFacet, LiquidationFacet, YieldFacet
- Calls go through facets: `oracleFacet.updatePythPrices()`, `vaultFacet.createVault()`, etc.

## Migration Steps

1. **Update test imports:**
   ```solidity
   import {wsXmrHub} from "../contracts/core/wsXmrHub.sol";
   import {OracleFacet} from "../contracts/facets/OracleFacet.sol";
   import {VaultFacet} from "../contracts/facets/VaultFacet.sol";
   import {MintFacet} from "../contracts/facets/MintFacet.sol";
   import {BurnFacet} from "../contracts/facets/BurnFacet.sol";
   import {LiquidationFacet} from "../contracts/facets/LiquidationFacet.sol";
   import {YieldFacet} from "../contracts/facets/YieldFacet.sol";
   ```

2. **Update setUp():**
   ```solidity
   function setUp() public {
       verifier = new MockVerifierProxy();
       wsxmr = new wsXMR();
       
       // Deploy Hub
       hub = new wsXmrHub(address(wsxmr), address(verifier));
       
       // Deploy Facets
       oracleFacet = new OracleFacet(address(wsxmr), address(verifier));
       vaultFacet = new VaultFacet(address(wsxmr), address(verifier));
       mintFacet = new MintFacet(address(wsxmr), address(verifier));
       burnFacet = new BurnFacet(address(wsxmr), address(verifier));
       liquidationFacet = new LiquidationFacet(address(wsxmr), address(verifier));
       yieldFacet = new YieldFacet(address(wsxmr), address(verifier));
       
       // Register facets with Hub
       hub.registerFacets(
           address(vaultFacet),
           address(mintFacet),
           address(burnFacet),
           address(liquidationFacet),
           address(yieldFacet),
           address(oracleFacet)
       );
       
       // Set Hub as wsXMR minter
       wsxmr.setHub(address(hub));
   }
   ```

3. **Update test calls:**
   - `vaultManager.updatePrices()` → `oracleFacet.updatePythPrices()`
   - `vaultManager.createVault()` → `vaultFacet.createVault()`
   - `vaultManager.depositCollateral()` → `vaultFacet.depositCollateral()`
   - `vaultManager.initiateMint()` → `mintFacet.initiateMint()`
   - `vaultManager.requestBurn()` → `burnFacet.requestBurn()`
   - `vaultManager.liquidate()` → `liquidationFacet.liquidate()`
   - etc.

## Quick Test Build

To test if the new contracts compile without running tests:

```bash
forge build --skip test
```

## Old Files Preserved

The old `VaultManager.sol` has been renamed to `VaultManager.sol.OLD` for reference.
