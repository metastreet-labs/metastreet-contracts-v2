// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.17;

import "@openzeppelin/contracts/utils/math/Math.sol";

import "../InterestRateModel.sol";

/**
 * @title Fixed Interest Rate Model with a constant, fixed rate.
 * @author MetaStreet Labs
 */
contract FixedInterestRateModel is InterestRateModel {
    /**************************************************************************/
    /* Constants */
    /**************************************************************************/

    /**
     * @notice Implementation version
     */
    string public constant IRM_IMPLEMENTATION_VERSION = "1.0";

    /**
     * @notice Fixed point scale
     */
    uint256 internal constant FIXED_POINT_SCALE = 1e18;

    /**************************************************************************/
    /* Structures */
    /**************************************************************************/

    /**
     * @notice Parameters
     * @param fixedInterestRate Fixed interest rate in interest per second
     * @param tickThreshold Tick interest threhsold
     * @param tickExponential Tick exponential base
     */
    struct Parameters {
        uint64 fixedInterestRate;
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

    /**
     * @notice Utilization
     * @dev Currently unused, but updated to simulate storage costs.
     */
    uint64 private _utilization;

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
    function interestRateModel() external pure override returns (string memory) {
        return "FixedInterestRateModel";
    }

    /**
     * @inheritdoc InterestRateModel
     */
    function rate() public view override returns (uint256) {
        return _params.fixedInterestRate;
    }

    /**
     * @inheritdoc InterestRateModel
     */
    function distribute(
        uint256 amount,
        uint256 interest,
        ILiquidity.NodeSource[] memory nodes,
        uint16 count
    ) public view override returns (uint128[] memory) {
        /* Interest threshold for tick to receive interest */
        uint256 threshold = Math.mulDiv(_params.tickThreshold, amount, FIXED_POINT_SCALE);

        /* Interest weight starting at final tick */
        uint256 base = _params.tickExponential;
        uint256 weight = Math.mulDiv(FIXED_POINT_SCALE, FIXED_POINT_SCALE, base);

        /* Interest normalization */
        uint256 normalization;

        /* Assign weighted interest to ticks backwards */
        uint128[] memory pending = new uint128[](count);
        for (uint256 i = 0; i < count; i++) {
            uint256 index = count - i - 1;

            /* Skip tick if it's below threshold */
            if (nodes[index].used <= threshold) continue;

            /* Calculate contribution of this tick to total amount */
            uint256 contribution = Math.mulDiv(nodes[index].used, FIXED_POINT_SCALE, amount);

            /* Calculate interest weight scaled by contribution */
            uint256 scaledWeight = Math.mulDiv(weight, contribution, FIXED_POINT_SCALE);

            /* Calculate unnormalized interest to tick */
            pending[index] = uint128(Math.mulDiv(scaledWeight, interest, FIXED_POINT_SCALE));

            /* Accumulate scaled interest weight for later normalization */
            normalization += scaledWeight;

            /* Adjust interest weight for next tick */
            weight = Math.mulDiv(weight, FIXED_POINT_SCALE, base);
        }

        /* Normalize assigned interest */
        for (uint256 i = 0; i < count; i++) {
            /* Calculate normalized interest to tick */
            pending[i] = uint128(Math.mulDiv(pending[i], FIXED_POINT_SCALE, normalization));

            /* Subtract from total interest */
            interest -= pending[i];
        }

        /* Drop off dust at lowest tick */
        pending[0] += uint128(interest);

        return pending;
    }

    /**
     * @inheritdoc InterestRateModel
     */
    function _onUtilizationUpdated(uint256 utilization) internal override {
        _utilization = uint64(utilization);
    }
}
