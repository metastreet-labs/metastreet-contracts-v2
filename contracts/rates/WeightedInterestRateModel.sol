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

    /**
     * @notice Minimum tick exponential (0.25)
     */
    uint256 internal constant MIN_TICK_EXPONENTIAL = 0.25 * 1e18;

    /**
     * @notice Maximum tick exponential (4.0)
     */
    uint256 internal constant MAX_TICK_EXPONENTIAL = 4.0 * 1e18;

    /**************************************************************************/
    /* Structures */
    /**************************************************************************/

    /**
     * @notice Parameters
     * @param tickExponential Tick exponential base
     */
    struct Parameters {
        uint64 tickExponential;
    }

    /**************************************************************************/
    /* Errors */
    /**************************************************************************/

    /**
     * @notice Insufficient utilization
     */
    error InsufficientUtilization();

    /**************************************************************************/
    /* Immutable State */
    /**************************************************************************/

    /**
     * @notice Tick exponential base
     */
    uint64 internal immutable _tickExponential;

    /**************************************************************************/
    /* Constructor */
    /**************************************************************************/

    /**
     * @notice WeightedInterestRateModel constructor
     */
    constructor(Parameters memory parameters) {
        if (parameters.tickExponential < MIN_TICK_EXPONENTIAL) revert InvalidInterestRateModelParameters();
        if (parameters.tickExponential > MAX_TICK_EXPONENTIAL) revert InvalidInterestRateModelParameters();

        _tickExponential = parameters.tickExponential;
    }

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
    function _rate(
        uint256 amount,
        uint64[] memory rates,
        LiquidityLogic.NodeSource[] memory nodes,
        uint16 count
    ) internal pure override returns (uint256) {
        uint256 weightedRate;

        /* Accumulate weighted rate */
        for (uint256 i; i < count; i++) {
            (, , uint256 rateIndex, ) = Tick.decode(nodes[i].tick);
            weightedRate += (uint256(nodes[i].used) * rates[rateIndex]) / FIXED_POINT_SCALE;
        }

        /* Return normalized weighted rate */
        return Math.mulDiv(weightedRate, FIXED_POINT_SCALE, amount);
    }

    /**
     * @inheritdoc InterestRateModel
     */
    function _distribute(
        uint256 amount,
        uint256 interest,
        LiquidityLogic.NodeSource[] memory nodes,
        uint16 count
    ) internal view override {
        /* Interest weight starting at final tick */
        uint256 base = _tickExponential;
        uint256 weight = (FIXED_POINT_SCALE * FIXED_POINT_SCALE) / base;

        /* Assign weighted interest to ticks backwards */
        uint128[] memory interests = new uint128[](count);
        uint256 normalization;
        for (uint256 i; i < count; i++) {
            /* Compute index */
            uint256 index = count - i - 1;

            /* Compute scaled weight */
            uint256 scaledWeight = Math.mulDiv(weight, nodes[index].used, amount);

            /* Assign weighted interest */
            interests[index] = Math.mulDiv(scaledWeight, interest, FIXED_POINT_SCALE).toUint128();

            /* Accumulate scaled weight for later normalization */
            normalization += scaledWeight;

            /* Adjust interest weight for next tick */
            weight = Math.mulDiv(weight, FIXED_POINT_SCALE, base);
        }

        /* Validate normalization is non-zero */
        if (normalization == 0) revert InsufficientUtilization();

        /* Normalize weighted interest */
        for (uint256 i; i < count; i++) {
            /* Calculate normalized interest to tick */
            uint256 normalizedInterest = (interests[i] * FIXED_POINT_SCALE) / normalization;

            /* Assign node pending amount */
            nodes[i].pending = nodes[i].used + normalizedInterest.toUint128();

            /* Track remaining interest */
            interest -= normalizedInterest;
        }

        /* Drop off remaining dust at lowest tick */
        nodes[0].pending += interest.toUint128();
    }
}
