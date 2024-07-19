// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.25;

import "@openzeppelin/contracts/utils/math/Math.sol";

/**
 * @title Tick
 * @author MetaStreet Labs
 */
library Tick {
    /*
     * A tick encodes three conditions on liquidity: limit, duration, rate, and type.
     * Limit is the maximum depth that liquidity sourced from the node can be
     * used in. Duration is the maximum allowed duration for that liquidity.
     * Rate is the interest rate associated with that liquidity. Duration and
     * rates are encoded as indexes into predetermined, discrete tiers. Type is the
     * type of limit, which could either be absolute or ratio-based.
     *
     * +---------------------------------------------------------------------+
     * |                                 128                                 |
     * +--------------------------------------|----------|----------|--------+
     * |                  120                 |    3     |     3    |    2   |
     * |                 Limit                | Dur. Idx | Rate Idx |  Type  |
     * +---------------------------------------------------------------------+
     *
     * Duration Index is ordered from longest duration to shortest, e.g. 30
     * days, 14 days, 7 days.
     *
     * Rate Index is ordered from lowest rate to highest rate, e.g. 10%, 30%,
     * 50%.
     */

    /**************************************************************************/
    /* Structures */
    /**************************************************************************/

    /**
     * @notice Limit type
     */
    enum LimitType {
        Absolute,
        Ratio
    }

    /**************************************************************************/
    /* Constants */
    /**************************************************************************/

    /**
     * @notice Tick limit mask
     */
    uint256 internal constant TICK_LIMIT_MASK = 0xffffffffffffffffffffffffffffff;

    /**
     * @notice Tick limit shift
     */
    uint256 internal constant TICK_LIMIT_SHIFT = 8;

    /**
     * @notice Tick duration index mask
     */
    uint256 internal constant TICK_DURATION_MASK = 0x7;

    /**
     * @notice Tick duration index shift
     */
    uint256 internal constant TICK_DURATION_SHIFT = 5;

    /**
     * @notice Tick rate index mask
     */
    uint256 internal constant TICK_RATE_MASK = 0x7;

    /**
     * @notice Tick rate index shift
     */
    uint256 internal constant TICK_RATE_SHIFT = 2;

    /**
     * @notice Tick limit type mask
     */
    uint256 internal constant TICK_LIMIT_TYPE_MASK = 0x3;

    /**
     * @notice Maximum number of durations supported
     */
    uint256 internal constant MAX_NUM_DURATIONS = TICK_DURATION_MASK + 1;

    /**
     * @notice Maximum number of rates supported
     */
    uint256 internal constant MAX_NUM_RATES = TICK_RATE_MASK + 1;

    /**
     * @notice Basis points scale
     */
    uint256 internal constant BASIS_POINTS_SCALE = 10_000;

    /**************************************************************************/
    /* Errors */
    /**************************************************************************/

    /**
     * @notice Invalid tick
     */
    error InvalidTick();

    /**************************************************************************/
    /* Helper Functions */
    /**************************************************************************/

    /**
     * @dev Decode a Tick
     * @param tick Tick
     * @param oraclePrice Oracle price
     * @return limit Limit field
     * @return duration Duration field
     * @return rate Rate field
     * @return limitType Limit type field
     */
    function decode(
        uint128 tick,
        uint256 oraclePrice
    ) internal pure returns (uint256 limit, uint256 duration, uint256 rate, LimitType limitType) {
        limit = ((tick >> TICK_LIMIT_SHIFT) & TICK_LIMIT_MASK);
        duration = ((tick >> TICK_DURATION_SHIFT) & TICK_DURATION_MASK);
        rate = ((tick >> TICK_RATE_SHIFT) & TICK_RATE_MASK);
        limitType = tick == type(uint128).max ? LimitType.Absolute : LimitType(tick & TICK_LIMIT_TYPE_MASK);
        limit = limitType == LimitType.Ratio ? Math.mulDiv(oraclePrice, limit, BASIS_POINTS_SCALE) : limit;
    }

    /**
     * @dev Validate a Tick (fast)
     * @param tick Tick
     * @param prevTick Previous tick
     * @param maxDurationIndex Maximum Duration Index (inclusive)
     * @param oraclePrice Oracle price
     * @return Limit field
     */
    function validate(
        uint128 tick,
        uint128 prevTick,
        uint256 maxDurationIndex,
        uint256 oraclePrice
    ) internal pure returns (uint256) {
        (uint256 prevLimit, uint256 prevDuration, uint256 prevRate, ) = decode(prevTick, oraclePrice);
        (uint256 limit, uint256 duration, uint256 rate, ) = decode(tick, oraclePrice);
        if (limit < prevLimit) revert InvalidTick();
        if (limit == prevLimit && duration < prevDuration) revert InvalidTick();
        if (limit == prevLimit && duration == prevDuration && rate <= prevRate) revert InvalidTick();
        if (duration > maxDurationIndex) revert InvalidTick();
        return limit;
    }

    /**
     * @dev Validate a Tick (slow)
     * @param tick Tick
     * @param minLimit Minimum Limit (exclusive)
     * @param minDurationIndex Minimum Duration Index (inclusive)
     * @param maxDurationIndex Maximum Duration Index (inclusive)
     * @param minRateIndex Minimum Rate Index (inclusive)
     * @param maxRateIndex Maximum Rate Index (inclusive)
     */
    function validate(
        uint128 tick,
        uint256 minLimit,
        uint256 minDurationIndex,
        uint256 maxDurationIndex,
        uint256 minRateIndex,
        uint256 maxRateIndex
    ) internal pure {
        (uint256 limit, uint256 duration, uint256 rate, LimitType limitType) = decode(tick, BASIS_POINTS_SCALE);
        if (limit <= minLimit) revert InvalidTick();
        if (duration < minDurationIndex) revert InvalidTick();
        if (duration > maxDurationIndex) revert InvalidTick();
        if (rate < minRateIndex) revert InvalidTick();
        if (rate > maxRateIndex) revert InvalidTick();
        if (limitType == LimitType.Ratio && limit > BASIS_POINTS_SCALE) revert InvalidTick();
    }
}
