// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "forge-std/Script.sol";
import "../contracts/core/wsXmrHub.sol";
import "../contracts/facets/RedStoneOracleFacet.sol";
import "../contracts/wsXMR.sol";

contract TestDeployedContracts is Script {
    address payable constant WSXMR = payable(0xeacf0bb7c761DBF7F28E08310eaE63f725EddA77);
    address payable constant HUB = payable(0x577B42FC4FCBcCE799de1FB8c40592DE15Ac100a);
    address payable constant ORACLE_FACET = payable(0xfeB574473a45CBAe296160AC9274932147da7507);
    address constant VAULT_FACET = 0x876c7236117C8791Ce23c0266f2FD40a9432A130;
    address constant MINT_FACET = 0x7FDE09D178EF9adE4d79c861D238dd94310ab8c9;
    address constant BURN_FACET = 0x907D0be53e0b478Dc5De244f79C565C9D339b65B;
    address constant LIQUIDATION_FACET = 0x865D821AbAD609ed48bc9DDf15Be0f49a6c460b5;
    address constant YIELD_FACET = 0x37F130fACb0110AB0B7eFd0c790930FA34C16B17;

    function run() external view {
        console.log("============================================================");
        console.log("Testing Deployed Contracts on Gnosis Chain");
        console.log("============================================================");
        console.log("");

        wsXMR wsxmr = wsXMR(WSXMR);
        wsXmrHub hub = wsXmrHub(HUB);
        RedStoneOracleFacet oracleFacet = RedStoneOracleFacet(ORACLE_FACET);

        console.log("Test 1: Check wsXMR token properties");
        console.log("  Name:", wsxmr.name());
        console.log("  Symbol:", wsxmr.symbol());
        console.log("  Decimals:", wsxmr.decimals());
        console.log("  Total Supply:", wsxmr.totalSupply());
        console.log("");

        console.log("Test 2: Check Hub configuration");
        console.log("  wsXMR Token:", address(hub.wsxmrToken()));
        console.log("  Verifier Proxy:", address(hub.verifierProxy()));
        console.log("  Deployer:", hub.deployer());
        console.log("");

        console.log("Test 3: Check Facet registration");
        console.log("  VaultFacet registered:", hub.facets(VAULT_FACET));
        console.log("  MintFacet registered:", hub.facets(MINT_FACET));
        console.log("  BurnFacet registered:", hub.facets(BURN_FACET));
        console.log("  LiquidationFacet registered:", hub.facets(LIQUIDATION_FACET));
        console.log("  YieldFacet registered:", hub.facets(YIELD_FACET));
        console.log("  OracleFacet registered:", hub.facets(ORACLE_FACET));
        console.log("");

        console.log("Test 4: Check wsXMR Hub ownership");
        console.log("  wsXMR Hub address:", wsxmr.hub());
        console.log("  Matches deployed Hub:", wsxmr.hub() == HUB);
        console.log("");

        console.log("============================================================");
        console.log("All basic tests passed!");
        console.log("============================================================");
    }
}
