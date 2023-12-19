// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.20;

import "@openzeppelin/contracts/utils/math/Math.sol";
import "@openzeppelin/contracts/utils/math/SafeCast.sol";

import "./InterestRateModel.sol";
import "../Tick.sol";

/**
 * @title Simple Interest Rate Model
 * @author MetaStreet Labs
 */
contract SimpleInterestRateModel is InterestRateModel {
    using SafeCast for uint256;

    /**************************************************************************/
    /* Implementation */
    /**************************************************************************/

    /**
     * @inheritdoc InterestRateModel
     */
    function INTEREST_RATE_MODEL_NAME() external pure override returns (string memory) {
        return "SimpleInterestRateModel";
    }

    /**
     * @inheritdoc InterestRateModel
     */
    function INTEREST_RATE_MODEL_VERSION() external pure override returns (string memory) {
        return "1.0";
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
        /* Declare gross interest */
        uint256 grossInterest;
        uint256[] memory grossInterests = new uint256[](count);

        /* Calculate gross interest */
        for (uint256 i; i < count; i++) {
            (, , uint256 rateIndex, ) = Tick.decode(nodes[i].tick);

            grossInterests[i] = Math.mulDiv(
                nodes[i].used,
                rates[rateIndex] * duration,
                LiquidityLogic.FIXED_POINT_SCALE
            );

            /* Update cumulative interest */
            grossInterest += grossInterests[i];
        }

        /* Compute repayment and admin fee */
        uint256 repayment = principal + grossInterest;
        uint256 adminFee = (adminFeeRate * grossInterest) / LiquidityLogic.BASIS_POINTS_SCALE;

        /* Deduct admin fee from gross interest */
        uint256 netInterest = grossInterest - adminFee;

        /* Second pass to assign net interest to ticks */
        uint256 netInterestRemaining = netInterest;
        for (uint256 i; i < count; i++) {
            /* Compute interest to tick */
            uint256 interest = Math.mulDiv(netInterest, grossInterests[i], grossInterest);

            /* Assign node pending amount */
            nodes[i].pending = nodes[i].used + interest.toUint128();

            /* Track remaining interest */
            netInterestRemaining -= interest;
        }

        /* Drop off remaining interest dust at lowest node */
        nodes[0].pending += netInterestRemaining.toUint128();

        return (repayment, adminFee);
    }
}
