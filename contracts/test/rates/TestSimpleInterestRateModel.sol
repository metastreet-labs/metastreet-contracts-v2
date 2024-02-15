// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.20;

import "../../rates/SimpleInterestRateModel.sol";

/**
 * @title Test Contract Wrapper for SimpleInterestRateModel
 * @author MetaStreet Labs
 */
contract TestSimpleInterestRateModel is SimpleInterestRateModel {
    /**************************************************************************/
    /* Constructor */
    /**************************************************************************/

    constructor() SimpleInterestRateModel() {}

    /**************************************************************************/
    /* Wrapper for Primary API */
    /**************************************************************************/

    /**
     * @dev External wrapper for _price()
     */
    function price(
        uint256 principal,
        uint64 duration,
        LiquidityLogic.NodeSource[] memory nodes,
        uint16 count,
        uint64[] memory rates,
        uint32 adminFeeRate
    ) external pure returns (uint256, uint256, uint128[] memory) {
        (uint256 repayment, uint256 adminFee) = _price(principal, duration, nodes, count, rates, adminFeeRate);

        uint128[] memory pending = new uint128[](count);
        for (uint256 i; i < count; i++) {
            pending[i] = nodes[i].pending;
        }

        return (repayment, adminFee, pending);
    }
}
