// SPDX-License-Identifier: LGPLv3
pragma solidity ^0.8.28;

import {BnbOracleFacet} from "./BnbOracleFacet.sol";

/**
 * @title RobinhoodOracleFacet
 * @notice Robinhood Chain deployment oracle — identical mechanism to
 *         BnbOracleFacet (RedStone pull for XMR + on-chain TWAP for
 *         collateral); subclassed purely for deployment/reporting clarity.
 */
contract RobinhoodOracleFacet is BnbOracleFacet {
    constructor(address _wsxmrToken, address _verifierProxy)
        BnbOracleFacet(_wsxmrToken, _verifierProxy)
    {}
}
