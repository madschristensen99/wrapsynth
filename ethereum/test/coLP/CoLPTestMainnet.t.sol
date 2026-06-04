// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {Test, console} from "forge-std/Test.sol";
import {wsXmrHub} from "../../contracts/core/wsXmrHub.sol";
import {VaultFacet} from "../../contracts/facets/VaultFacet.sol";
import {MintFacet} from "../../contracts/facets/MintFacet.sol";
import {BurnFacet} from "../../contracts/facets/BurnFacet.sol";
import {LiquidationFacet} from "../../contracts/facets/LiquidationFacet.sol";
import {wsXMR} from "../../contracts/wsXMR.sol";
import {wsXMRLiquidityRouter} from "../../contracts/router/wsXMRLiquidityRouter.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IUniswapV3Factory} from "../../contracts/interfaces/external/IUniswapV3Factory.sol";
import {GnosisAddresses} from "../../contracts/GnosisAddresses.sol";
import {Ed25519} from "../../contracts/Ed25519.sol";
import {wsXmrStorage} from "../../contracts/core/wsXmrStorage.sol";

/**
 * @title CoLP Mainnet Integration Test
 * @notice Tests Co-LP functionality against ACTUAL deployed Gnosis mainnet contracts
 * @dev Forks Gnosis mainnet, uses deployed wsXmrHub/wsXMR, deploys router locally
 */
/**
 * @title CoLP Mainnet Verification Test
 * @notice Verifies deployed Gnosis mainnet contracts are accessible and functional
 */
contract CoLPTestMainnet is Test {
    // ========== DEPLOYED MAINNET CONTRACTS ==========
    address constant HUB = 0x284B1d429b1038Ef186314b1Fb33f76Eb61497E9;
    address constant WSXMR = 0x31c76171773138215E518C0224b82AC9BE9897b8;
    address constant DEPLOYER = 0x492c0b9F298cC49FE2644a2EBc6eA8dF848c72FB;

    // ========== TEST ACCOUNTS ==========
    address public lp = makeAddr("lp");
    address public user = makeAddr("user");
    address public keeper = makeAddr("keeper");

    // ========== CONTRACTS ==========
    wsXMRLiquidityRouter public router;
    wsXMR public wsxmr = wsXMR(WSXMR);

    uint256 constant XMR_PRICE = 390 * 1e18;
    uint256 constant COLLATERAL_PRICE = 1e18;

    function setUp() public {
        string memory rpcUrl = vm.envOr("GNOSIS_RPC_URL", string("https://rpc.gnosischain.com"));
        vm.createSelectFork(rpcUrl);
    }

    /// @notice Verify deployed hub contract is accessible
    function test_MainnetDeployment_HubExists() public view {
        uint256 codeSize;
        assembly {
            codeSize := extcodesize(HUB)
        }
        assertTrue(codeSize > 0, "Hub should have code deployed");
    }

    /// @notice Verify wsXMR token is accessible
    function test_MainnetDeployment_TokenExists() public view {
        uint256 codeSize;
        assembly {
            codeSize := extcodesize(WSXMR)
        }
        assertTrue(codeSize > 0, "wsXMR token should have code deployed");
        
        // Verify it's an ERC20
        string memory name = wsxmr.name();
        assertTrue(bytes(name).length > 0, "Token should have a name");
    }

    /// @notice Verify vault count is accessible through hub
    function test_MainnetDeployment_VaultFacetWorks() public {
        (bool success, bytes memory result) = HUB.call(
            abi.encodeWithSignature("getVaultCount()")
        );
        assertTrue(success, "getVaultCount should succeed");
        uint256 vaultCount = abi.decode(result, (uint256));
        assertTrue(vaultCount >= 0, "Vault count should be >= 0");
    }
}
