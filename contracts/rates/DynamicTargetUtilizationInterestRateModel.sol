// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.17;

import "@openzeppelin/contracts/utils/math/Math.sol";

import "../interfaces/IInterestRateModel.sol";

/**
 * @title Dynamic Target Utilization Interest Rate Model
 * @author MetaStreet Labs
 */
contract DynamicTargetUtilizationInterestRateModel is IInterestRateModel {
    /**************************************************************************/
    /* Constants */
    /**************************************************************************/

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
    struct Parameters {
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
    struct State {
        uint64 target;
        uint64 utilization;
        uint64 rate;
        uint64 timestamp;
    }

    /**************************************************************************/
    /* State */
    /**************************************************************************/

    /**
     * @notice Initialized boolean
     */
    bool private _initialized;

    /**
     * @notice Owner
     */
    address private _owner;

    /**
     * @notice Padding
     */
    uint88 private _padding;

    /**
     * @notice Controller parameters
     */
    Parameters private _parameters;

    /**
     * @notice Controller state
     */
    State internal _state;

    /**
     * @notice Tick interest threshold
     */
    uint64 private _tickThreshold;

    /**
     * @notice Tick exponential base
     */
    uint64 private _tickExponential;

    /**************************************************************************/
    /* Constructor */
    /**************************************************************************/

    /**
     * @notice FixedInterestRateModel constructor
     */
    constructor() {
        /* Disable initialization of implementation contract */
        _initialized = true;
    }

    /**************************************************************************/
    /* Initializer */
    /**************************************************************************/

    /**
     * @notice Initializer
     * @param params ABI-encoded parameters
     */
    function initialize(bytes memory params) external {
        require(!_initialized, "Already initialized");

        _initialized = true;
        _owner = msg.sender;

        (
            Parameters memory parameters,
            uint64 target,
            uint64 initialRate,
            uint64 tickThreshold,
            uint64 tickExponential
        ) = abi.decode(params, (Parameters, uint64, uint64, uint64, uint64));
        _parameters = parameters;
        _state.target = target;
        _state.utilization = 0;
        _state.rate = initialRate;
        _state.timestamp = uint64(block.timestamp);
        _tickThreshold = tickThreshold;
        _tickExponential = tickExponential;
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
        Parameters memory parameters = _parameters;
        State memory state = _state;

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
    function getParameters() external view returns (Parameters memory) {
        return _parameters;
    }

    /**
     * @notice Get internal state
     * @return State
     */
    function getState() external view returns (State memory) {
        return _state;
    }

    /**************************************************************************/
    /* Implementation */
    /**************************************************************************/

    /**
     * @inheritdoc IInterestRateModel
     */
    function name() external pure returns (string memory) {
        return "DynamicTargetUtilizationInterestRateModel";
    }

    /**
     * @inheritdoc IInterestRateModel
     */
    function rate() external view returns (uint256) {
        return _qToUD(_rate());
    }

    /**
     * @inheritdoc IInterestRateModel
     */
    function distribute(
        uint256 amount,
        uint256 interest,
        ILiquidity.NodeSource[] memory nodes,
        uint16 count
    ) external view returns (uint128[] memory) {
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
            if (nodes[index].used < threshold) continue;

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
     * @inheritdoc IInterestRateModel
     */
    function onUtilizationUpdated(uint256 utilization) external {
        if (msg.sender != _owner) revert("Invalid caller");

        /* Snapshot current rate */
        _state.rate = _rate();
        /* Update utilization and timestamp */
        _state.utilization = uint64(_udToQ(utilization));
        _state.timestamp = uint64(block.timestamp);
    }
}
