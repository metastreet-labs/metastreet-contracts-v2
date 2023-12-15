// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.20;

import "../../rates/WeightedInterestRateModel.sol";

/**
 * @title Test Contract Wrapper for WeightedInterestRateModel
 * @author MetaStreet Labs
 */
contract TestWeightedInterestRateModel is WeightedInterestRateModel {
    /**************************************************************************/
    /* Wrapper for Primary API */
    /**************************************************************************/

    /**
     * @dev External wrapper function for _distribute()
     */
    function distribute(
        uint64 duration,
        uint32 adminFeeRate,
        uint64[] memory rates,
        LiquidityLogic.NodeSource[] memory nodes
    ) external pure returns (uint128[] memory, uint256, uint256) {
        (uint256 repayment, uint256 adminFee) = _distribute(duration, adminFeeRate, rates, nodes);

        uint128[] memory pending = new uint128[](nodes.length);
        for (uint256 i; i < nodes.length; i++) {
            pending[i] = nodes[i].pending;
        }
        return (pending, repayment, adminFee);
    }
}
