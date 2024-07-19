// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.25;

import "../Tick.sol";

/**
 * @title Test Contract Wrapper for Tick Library
 * @author MetaStreet Labs
 */
contract TestTick {
    /**
     * @dev External wrapper function for Tick.decode()
     */
    function decode(
        uint128 tick,
        uint256 oraclePrice
    ) external pure returns (uint256 limit, uint256 duration, uint256 rate, Tick.LimitType limitType) {
        return Tick.decode(tick, oraclePrice);
    }

    /**
     * @dev External wrapper function for Tick.validate()
     */
    function validate(
        uint128 tick,
        uint128 prevTick,
        uint256 minDurationIndex,
        uint256 oraclePrice
    ) external pure returns (uint256) {
        return Tick.validate(tick, prevTick, minDurationIndex, oraclePrice);
    }

    /**
     * @dev External wrapper function for Tick.validate()
     */
    function validate(
        uint128 tick,
        uint256 minLimit,
        uint256 minDurationIndex,
        uint256 maxDurationIndex,
        uint256 minRateIndex,
        uint256 maxRateIndex
    ) external pure {
        return Tick.validate(tick, minLimit, minDurationIndex, maxDurationIndex, minRateIndex, maxRateIndex);
    }
}
