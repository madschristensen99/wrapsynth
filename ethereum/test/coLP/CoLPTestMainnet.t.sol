// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {Test, console} from "forge-std/Test.sol";
import {HyperEVMTestBase} from "../HyperEVMTestBase.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IUniswapV3Factory} from "../../contracts/interfaces/external/IUniswapV3Factory.sol";

/**
 * @title HyperEVM Infrastructure Verification Test
 * @notice Verifies the deployed HyperEVM mainnet dependencies the protocol relies on
 *         (USDe, HyperLend pool/aToken, HyperSwap factory/router/NFPM) are accessible.
 * @dev Forks HyperEVM. The original Gnosis version verified the deployed wsXmrHub/wsXMR;
 *      on HyperEVM those aren't deployed yet (Phase 4), so this verifies the external
 *      infrastructure contracts the fork environment depends on instead.
 */
contract CoLPTestMainnet is HyperEVMTestBase {
    function setUp() public override {
        // Only need the fork — skip the full protocol deploy for these infra checks.
        string memory rpcUrl = vm.envOr("HYPEREVM_RPC_URL", string("https://rpc.hyperliquid.xyz/evm"));
        uint256 forkBlock = vm.envOr("HYPEREVM_FORK_BLOCK", uint256(0));
        if (forkBlock == 0) {
            vm.createSelectFork(rpcUrl);
        } else {
            vm.createSelectFork(rpcUrl, forkBlock);
        }
    }

    function _hasCode(address a) internal view returns (bool) {
        uint256 size;
        assembly {
            size := extcodesize(a)
        }
        return size > 0;
    }

    /// @notice USDe (the collateral underlying) is deployed and is an ERC20
    function test_Infra_USDeDeployed() public view {
        assertTrue(_hasCode(USDE), "USDe should have code deployed");
        assertGt(IERC20(USDE).totalSupply(), 0, "USDe should have nonzero supply");
    }

    /// @notice HyperLend pool + USDe aToken are deployed (collateral yield venue)
    function test_Infra_HyperLendDeployed() public view {
        assertTrue(_hasCode(HYPERLEND_POOL), "HyperLend pool should have code");
        assertTrue(_hasCode(HYPERLEND_ATOKEN), "HyperLend aToken should have code");
    }

    /// @notice HyperSwap factory / router / NFPM are deployed (co-LP + buy-and-burn venue)
    function test_Infra_HyperSwapDeployed() public view {
        assertTrue(_hasCode(HYPERSWAP_FACTORY), "HyperSwap factory should have code");
        assertTrue(_hasCode(HYPERSWAP_ROUTER), "HyperSwap router should have code");
        assertTrue(_hasCode(HYPERSWAP_NFPM), "HyperSwap NFPM should have code");
    }

    /// @notice The HyperSwap factory responds to getPool (functional, not just code)
    function test_Infra_HyperSwapFactoryFunctional() public view {
        // getPool for a non-existent pair returns address(0) without reverting.
        address p = IUniswapV3Factory(HYPERSWAP_FACTORY).getPool(USDE, address(0x1), 3000);
        assertTrue(p == address(0) || _hasCode(p), "getPool should return 0 or a deployed pool");
    }
}
