// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.17;

import "@openzeppelin/contracts/utils/math/Math.sol";

import "../interfaces/IInterestRateModel.sol";

/**
 * @title Fixed Interest Rate Model with a constant, fixed rate.
 * @author MetaStreet Labs
 */
contract FixedInterestRateModel is IInterestRateModel {
    /**************************************************************************/
    /* Constants */
    /**************************************************************************/

    /**
     * @notice Fixed point scale
     */
    uint256 public constant FIXED_POINT_SCALE = 1e18;

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
     * @notice Fixed interest rate
     */
    uint64 private _fixedInterestRate;

    /**
     * @notice Tick interest threshold
     */
    uint64 private _tickThreshold;

    /**
     * @notice Tick exponential base
     */
    uint64 private _tickExponential;

    /**
     * @notice Utilization
     * @dev Currently unused, but updated to simulate storage costs.
     */
    uint64 private _utilization;

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

        (uint64 fixedInterestRate, uint64 tickThreshold, uint64 tickExponential) = abi.decode(
            params,
            (uint64, uint64, uint64)
        );
        _fixedInterestRate = fixedInterestRate;
        _tickThreshold = tickThreshold;
        _tickExponential = tickExponential;
    }

    /**************************************************************************/
    /* Implementation */
    /**************************************************************************/

    /**
     * @inheritdoc IInterestRateModel
     */
    function name() external pure returns (string memory) {
        return "FixedInterestRateModel";
    }

    /**
     * @inheritdoc IInterestRateModel
     */
    function rate() external view returns (uint256) {
        return _fixedInterestRate;
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
        uint256 threshold = Math.mulDiv(_tickThreshold, amount, FIXED_POINT_SCALE);

        /* Interest weight starting at final tick */
        uint256 base = _tickExponential;
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
     * @inheritdoc IInterestRateModel
     */
    function onUtilizationUpdated(uint256 utilization) external {
        if (msg.sender != _owner) revert("Invalid caller");

        _utilization = uint64(utilization);
    }
}
