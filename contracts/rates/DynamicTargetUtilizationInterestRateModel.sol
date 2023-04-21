// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.17;

import "@openzeppelin/contracts/utils/math/Math.sol";

import "../InterestRateModel.sol";

/**
 * @title Dynamic Target Utilization Interest Rate Model
 * @author MetaStreet Labs
 */
contract DynamicTargetUtilizationInterestRateModel is InterestRateModel {
    /**************************************************************************/
    /* Constants */
    /**************************************************************************/

    /**
     * @notice Interest rate model name
     */
    string public constant INTEREST_RATE_MODEL_NAME = "DynamicTargetUtilizationInterestRateModel";

    /**
     * @notice Interest rate model version
     */
    string public constant INTEREST_RATE_MODEL_VERSION = "1.0";

    /**
     * @notice Fixed point decimal scale
     */
    uint256 internal constant FIXED_POINT_D_SCALE = 1e18;

    /**
     * @notice Fixed point binary scale (in bits)
     */
    uint256 internal constant FIXED_POINT_Q_BITS = 56;

    /**************************************************************************/
    /* Structures */
    /**************************************************************************/

    /*
     * Controller parameters and state are stored as UQX.Y binary fixed point
     * numbers. The input to the controller is utilization. The output of the
     * controller is a per-second interest rate.
     *
     * Assuming absolute minimum and maximum APRs of 0.0001% and 10,000%, and a
     * 64-bit wide integer container:
     *
     *  Minimum rate per second = (0.0001 / 100) / (365 * 86400) = 3.170979198376458650431253171E-14
     *  Maximum rate per second = (10000  / 100) / (365 * 86400) = 0.000003170979198376458650431253171
     *  Minimum number of fractional bits needed = math.log2(3.17e-14) = -44.84
     *  Minimum number of integral bits needed = 0 (maximium rate per second is less than 1)
     *
     * To keep things simple and byte aligned, we can use UQ8.56, giving us the
     * following range:
     *
     *  Minimum rate per second = 0x00.00000000000001 / 2^56 = 1.387778780781445675529539585E-17
     *  Maximum rate per second = 0xff.ffffffffffffff / 2^56 = 255.9999999999999999861222122
     *  Minimum APR = 1.387778780781445675529539585E-17 * 100 * (365 * 86400) = 4.3755E-8 %
     *  Maximum APR = 255.9999999999999999861222122     * 100 * (365 * 86400) = 807321599999 %
     */

    /**
     * @notice Controller parameters
     * @param margin Error margin (utilization)
     * @param gain Proportional gain
     * @param min Minimum output (rate)
     * @param max Maximum output (rate)
     */
    struct ControllerParameters {
        uint64 margin;
        uint64 gain;
        uint64 min;
        uint64 max;
    }

    /**
     * @notice Controller state
     * @param target Target utilization
     * @param utilization Current utilization
     * @param rate Current rate
     * @param timestamp Last update
     */
    struct ControllerState {
        uint64 target;
        uint64 utilization;
        uint64 rate;
        uint64 timestamp;
    }

    /**
     * @notice Initialization Parameters
     * @param controllerParameters Controller parameters
     * @param controllerTarget Target utilization in fixed point decimal
     * @param initialRate Initial rate in interest per second
     * @param tickThreshold Tick interest threhsold
     * @param tickExponential Tick exponential base
     */
    struct Parameters {
        ControllerParameters controllerParameters;
        uint64 controllerTarget;
        uint64 initialRate;
        uint64 tickThreshold;
        uint64 tickExponential;
    }

    /**************************************************************************/
    /* State */
    /**************************************************************************/

    /**
     * @notice Controller parameters
     */
    ControllerParameters private _parameters;

    /**
     * @notice Controller state
     */
    ControllerState internal _state;

    /**
     * @notice Tick interest threshold
     */
    uint64 private _tickThreshold;

    /**
     * @notice Tick exponential base
     */
    uint64 private _tickExponential;

    /**************************************************************************/
    /* Initializer */
    /**************************************************************************/

    /**
     * @notice Initializer
     * @param params ABI-encoded parameters
     */
    function _initialize(Parameters memory params) internal {
        _parameters = params.controllerParameters;
        _tickThreshold = params.tickThreshold;
        _tickExponential = params.tickExponential;

        _state.target = params.controllerTarget;
        _state.rate = params.initialRate;
        _state.utilization = 0;
        _state.timestamp = uint64(block.timestamp);
    }

    /**************************************************************************/
    /* Helper Functions for Fixed Point Math */
    /**************************************************************************/

    /**
     * @notice Add numbers with saturation
     */
    function _addSat(uint256 x, uint256 y, uint256 max) internal pure returns (uint256) {
        return Math.min(x + y, max);
    }

    /**
     * @notice Subtract numbers with saturation
     */
    function _subSat(uint256 x, uint256 y, uint256 min) internal pure returns (uint256) {
        return (y > x) ? min : Math.max(x - y, min);
    }

    /**
     * @notice Multiply two Q fixed point numbers with rounding
     */
    function _qmul(uint256 x, uint256 y) internal pure returns (uint256) {
        return ((x * y) + (1 << (FIXED_POINT_Q_BITS - 1))) >> FIXED_POINT_Q_BITS;
    }

    /**
     * @notice Convert integer to fixed point binary
     */
    function _intToQ(uint256 x) internal pure returns (uint256) {
        return x << FIXED_POINT_Q_BITS;
    }

    /**
     * @notice Convert fixed point decimal to fixed point binary
     */
    function _udToQ(uint256 x) internal pure returns (uint256) {
        return Math.mulDiv(x, 1 << FIXED_POINT_Q_BITS, FIXED_POINT_D_SCALE);
    }

    /**
     * @notice Convert fixed point binary to fixed point decimal
     */
    function _qToUD(uint64 x) internal pure returns (uint256) {
        return Math.mulDiv(x, FIXED_POINT_D_SCALE, 1 << FIXED_POINT_Q_BITS);
    }

    /**
     * @notice Compute current interest rate in UQ8.56
     */
    function _rate() internal view returns (uint64) {
        ControllerParameters memory parameters = _parameters;
        ControllerState memory state = _state;

        /* Compute error = abs(target - utilization) */
        uint256 error = state.target > state.utilization
            ? state.target - state.utilization
            : state.utilization - state.target;

        /* Adjust error within error margin */
        error = (error < parameters.margin) ? 0 : error;

        /* Determine elapsed time */
        uint256 elapsed = _intToQ(block.timestamp - state.timestamp);

        /* Compute adjustment = gain * error * elapsed */
        uint256 adjustment = _qmul(_qmul(parameters.gain, error), elapsed);

        /* Calculate rate with signed adjustment and saturation */
        return
            uint64(
                (state.target < state.utilization)
                    ? _addSat(state.rate, adjustment, parameters.max)
                    : _subSat(state.rate, adjustment, parameters.min)
            );
    }

    /**************************************************************************/
    /* Getters */
    /**************************************************************************/

    /**
     * @notice Get parameters
     * @return Parameters
     */
    function getControllerParameters() external view returns (ControllerParameters memory) {
        return _parameters;
    }

    /**
     * @notice Get internal state
     * @return State
     */
    function getControllerState() external view returns (ControllerState memory) {
        return _state;
    }

    /**************************************************************************/
    /* Implementation */
    /**************************************************************************/

    /**
     * @inheritdoc InterestRateModel
     */
    function rate(
        uint256,
        uint64[] memory,
        ILiquidity.NodeSource[] memory,
        uint16
    ) public view override returns (uint256) {
        return _qToUD(_rate());
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
        uint256 threshold = Math.mulDiv(_tickThreshold, amount, FIXED_POINT_D_SCALE);

        /* Interest weight starting at final tick */
        uint256 base = _tickExponential;
        uint256 weight = Math.mulDiv(FIXED_POINT_D_SCALE, FIXED_POINT_D_SCALE, base);

        /* Interest normalization */
        uint256 normalization;

        /* Assign weighted interest to ticks backwards */
        uint128[] memory pending = new uint128[](count);
        for (uint256 i = 0; i < count; i++) {
            uint256 index = count - i - 1;

            /* Skip tick if it's below threshold */
            if (nodes[index].used <= threshold) continue;

            /* Calculate contribution of this tick to total amount */
            uint256 contribution = Math.mulDiv(nodes[index].used, FIXED_POINT_D_SCALE, amount);

            /* Calculate interest weight scaled by contribution */
            uint256 scaledWeight = Math.mulDiv(weight, contribution, FIXED_POINT_D_SCALE);

            /* Calculate unnormalized interest to tick */
            pending[index] = uint128(Math.mulDiv(scaledWeight, interest, FIXED_POINT_D_SCALE));

            /* Accumulate scaled interest weight for later normalization */
            normalization += scaledWeight;

            /* Adjust interest weight for next tick */
            weight = Math.mulDiv(weight, FIXED_POINT_D_SCALE, base);
        }

        /* Normalize assigned interest */
        for (uint256 i = 0; i < count; i++) {
            /* Calculate normalized interest to tick */
            pending[i] = uint128(Math.mulDiv(pending[i], FIXED_POINT_D_SCALE, normalization));

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
        /* Snapshot current rate */
        _state.rate = _rate();
        /* Update utilization and timestamp */
        _state.utilization = uint64(_udToQ(utilization));
        _state.timestamp = uint64(block.timestamp);
    }
}
