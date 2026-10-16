// SPDX-License-Identifier: LGPLv3
pragma solidity ^0.8.28;

import {BnbOracleFacet} from "./BnbOracleFacet.sol";

/**
 * @title BaseOracleFacet
 * @notice Base deployment oracle — identical mechanism to BnbOracleFacet
 *         (RedStone pull for XMR + on-chain TWAP for collateral); subclassed
 *         purely for deployment/reporting clarity.
 */
contract BaseOracleFacet is BnbOracleFacet {
    constructor(address _wsxmrToken, address _verifierProxy)
        BnbOracleFacet(_wsxmrToken, _verifierProxy)
    {}
}
