// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.20;

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
    /* Constants */
    /**************************************************************************/

    /**
     * @notice Fixed point scale
     */
    uint256 internal constant FIXED_POINT_SCALE = 1e18;

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
        return "1.1";
    }

    /**
     * @inheritdoc InterestRateModel
     */
    function _distribute(
        uint64 duration,
        uint32 adminFeeRate,
        uint64[] memory rates,
        LiquidityLogic.NodeSource[] memory nodes
    ) internal pure override returns (uint256 totalRepayment, uint256 totalAdminFee) {
        /* Distribute pending to liquidity, and calculate total repayment & total admin fee */
        for (uint256 i; i < nodes.length; i++) {
            (, , uint256 rateIndex, ) = Tick.decode(nodes[i].tick);

            /* Calculate fee */
            uint256 fee = Math.mulDiv(nodes[i].used, rates[rateIndex] * duration, FIXED_POINT_SCALE);

            /* Calculate admin fee for the node */
            uint256 adminFee = Math.mulDiv(adminFeeRate, fee, LiquidityLogic.BASIS_POINTS_SCALE);

            /* Calculate admin fee for the node */
            uint256 repayment = nodes[i].used + fee;

            /* Distribute pending to liquidity */
            nodes[i].pending = (repayment - adminFee).toUint128();

            /* Sum total repayment */
            totalRepayment += repayment;

            /* Sum total admin fee */
            totalAdminFee += adminFee;
        }
    }
}
