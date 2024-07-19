// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.25;

import "@openzeppelin/contracts/utils/math/Math.sol";
import "@openzeppelin/contracts/utils/math/SafeCast.sol";

import "./InterestRateModel.sol";
import "../Tick.sol";

/**
 * @title Weighted Interest Rate Model
 * @author MetaStreet Labs
 */
contract WeightedInterestRateModel is InterestRateModel {
    using SafeCast for uint256;

    /**************************************************************************/
    /* Constructor */
    /**************************************************************************/

    /**
     * @notice WeightedInterestRateModel constructor
     */
    constructor() {}

    /**************************************************************************/
    /* Implementation */
    /**************************************************************************/

    /**
     * @inheritdoc InterestRateModel
     */
    function INTEREST_RATE_MODEL_NAME() external pure override returns (string memory) {
        return "WeightedInterestRateModel";
    }

    /**
     * @inheritdoc InterestRateModel
     */
    function INTEREST_RATE_MODEL_VERSION() external pure override returns (string memory) {
        return "2.0";
    }

    /**
     * @inheritdoc InterestRateModel
     */
    function _price(
        uint256 principal,
        uint64 duration,
        LiquidityLogic.NodeSource[] memory nodes,
        uint16 count,
        uint64[] memory rates,
        uint32 adminFeeRate
    ) internal pure override returns (uint256, uint256) {
        /* First pass to compute repayment and weights */
        uint256[] memory weights = new uint256[](count);
        uint256 repayment;
        uint256 normalization;
        for (uint256 i; i < count; i++) {
            /* Compute tick repayment */
            (, , uint256 rateIndex, ) = Tick.decode(nodes[i].tick, LiquidityLogic.BASIS_POINTS_SCALE);
            uint256 pending = nodes[i].used +
                Math.mulDiv(nodes[i].used, rates[rateIndex] * duration, LiquidityLogic.FIXED_POINT_SCALE);

            /* Update cumulative repayment */
            repayment += pending;

            /* Compute tick weight */
            weights[i] = Math.mulDiv(repayment, pending, principal);

            /* Accumulate weight for normalization */
            normalization += weights[i];
        }

        /* Compute interest and admin fee */
        uint256 interest = repayment - principal;
        uint256 adminFee = (interest * adminFeeRate) / LiquidityLogic.BASIS_POINTS_SCALE;

        /* Deduct admin fee from interest */
        interest -= adminFee;

        /* Second pass to assign weighted interest to ticks */
        uint256 interestRemaining = interest;
        for (uint256 i; i < count; i++) {
            /* Compute weighted interest to tick */
            uint256 weightedInterest = Math.mulDiv(interest, weights[i], normalization);

            /* Assign node pending amount */
            nodes[i].pending = nodes[i].used + weightedInterest.toUint128();

            /* Track remaining interest */
            interestRemaining -= weightedInterest;
        }

        /* Drop off remaining interest dust at lowest node */
        if (interestRemaining != 0) nodes[0].pending += interestRemaining.toUint128();

        return (repayment, adminFee);
    }
}
