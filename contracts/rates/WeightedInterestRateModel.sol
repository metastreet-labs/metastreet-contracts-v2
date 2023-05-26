// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.19;

import "@openzeppelin/contracts/utils/math/Math.sol";

import "../InterestRateModel.sol";
import "../Tick.sol";

/**
 * @title Weighted Interest Rate Model
 * @author MetaStreet Labs
 */
contract WeightedInterestRateModel is InterestRateModel {
    /**************************************************************************/
    /* Constants */
    /**************************************************************************/

    /**
     * @notice Interest rate model name
     */
    string public constant INTEREST_RATE_MODEL_NAME = "WeightedInterestRateModel";

    /**
     * @notice Interest rate model version
     */
    string public constant INTEREST_RATE_MODEL_VERSION = "1.0";

    /**
     * @notice Fixed point scale
     */
    uint256 internal constant FIXED_POINT_SCALE = 1e18;

    /**************************************************************************/
    /* Errors */
    /**************************************************************************/

    /**
     * @notice Insufficient utilization
     */
    error InsufficientUtilization();

    /**************************************************************************/
    /* Structures */
    /**************************************************************************/

    /**
     * @notice Parameters
     * @param tickThreshold Tick interest threshold
     * @param tickExponential Tick exponential base
     */
    struct Parameters {
        uint64 tickThreshold;
        uint64 tickExponential;
    }

    /**************************************************************************/
    /* State */
    /**************************************************************************/

    /**
     * @notice Parameters
     */
    Parameters private _params;

    /**************************************************************************/
    /* Initializer */
    /**************************************************************************/

    /**
     * @notice Initializer
     * @param params Parameters
     */
    function _initialize(Parameters memory params) internal {
        _params = params;
    }

    /**************************************************************************/
    /* Implementation */
    /**************************************************************************/

    /**
     * @inheritdoc InterestRateModel
     */
    function _rate(
        uint256 amount,
        uint64[] memory rates,
        ILiquidity.NodeSource[] memory nodes,
        uint16 count
    ) internal pure override returns (uint256) {
        uint256 weightedRate;

        /* Accumulate weighted rate */
        for (uint256 i; i < count; i++) {
            (, , uint256 rateIndex, ) = Tick.decode(nodes[i].tick);
            weightedRate += Math.mulDiv(nodes[i].used, rates[rateIndex], FIXED_POINT_SCALE);
        }

        /* Normalize weighted rate */
        weightedRate = Math.mulDiv(weightedRate, FIXED_POINT_SCALE, amount);

        return weightedRate;
    }

    /**
     * @inheritdoc InterestRateModel
     */
    function _distribute(
        uint256 amount,
        uint256 interest,
        ILiquidity.NodeSource[] memory nodes,
        uint16 count
    ) internal view override returns (uint128[] memory) {
        /* Interest threshold for tick to receive interest */
        uint256 threshold = Math.mulDiv(_params.tickThreshold, amount, FIXED_POINT_SCALE);

        /* Interest weight starting at final tick */
        uint256 base = _params.tickExponential;
        uint256 weight = Math.mulDiv(FIXED_POINT_SCALE, FIXED_POINT_SCALE, base);

        /* Assign weighted interest to ticks backwards */
        uint128[] memory pending = new uint128[](count);
        uint256 normalization;
        for (uint256 i; i < count; i++) {
            uint256 index = count - i - 1;

            /* Skip tick if it's below threshold */
            if (nodes[index].used <= threshold) continue;

            /* Compute scaled weight */
            uint256 scaledWeight = Math.mulDiv(weight, nodes[index].used, amount);

            /* Assign weighted interest */
            pending[index] = uint128(Math.mulDiv(scaledWeight, interest, FIXED_POINT_SCALE));

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
            pending[i] = uint128(Math.mulDiv(pending[i], FIXED_POINT_SCALE, normalization));

            /* Track remaining interest */
            interest -= pending[i];
        }

        /* Drop off remaining dust at lowest tick */
        pending[0] += uint128(interest);

        return pending;
    }
}
