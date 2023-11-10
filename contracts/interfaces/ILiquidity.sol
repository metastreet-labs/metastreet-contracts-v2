// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/**
 * @title Interface to Liquidity state
 */
interface ILiquidity {
    /**************************************************************************/
    /* Errors */
    /**************************************************************************/

    /**
     * @notice Insufficient liquidity
     */
    error InsufficientLiquidity();

    /**
     * @notice Inactive liquidity
     */
    error InactiveLiquidity();

    /**
     * @notice Insufficient tick spacing
     */
    error InsufficientTickSpacing();

    /**************************************************************************/
    /* Structures */
    /**************************************************************************/

    /**
     * @notice Flattened liquidity node returned by getter
     * @param tick Tick
     * @param value Liquidity value
     * @param shares Liquidity shares outstanding
     * @param available Liquidity available
     * @param pending Liquidity pending (with interest)
     * @param redemptions Total pending redemptions
     * @param prev Previous liquidity node
     * @param next Next liquidity node
     */
    struct NodeInfo {
        uint128 tick;
        uint128 value;
        uint128 shares;
        uint128 available;
        uint128 pending;
        uint128 redemptions;
        uint128 prev;
        uint128 next;
    }

    /**
     * @notice Accrual info returned by getter
     * @param accrued Accrued interest
     * @param rate Accrual rate
     * @param timestamp Accrual timestamp
     */
    struct AccrualInfo {
        uint128 accrued;
        uint64 rate;
        uint64 timestamp;
    }

    /**************************************************************************/
    /* API */
    /**************************************************************************/

    /**
     * Get liquidity nodes spanning [startTick, endTick] range
     * @param startTick Start tick
     * @param endTick End tick
     * @return Liquidity nodes
     */
    function liquidityNodes(uint128 startTick, uint128 endTick) external view returns (NodeInfo[] memory);

    /**
     * Get liquidity node at tick
     * @param tick Tick
     * @return Liquidity node
     */
    function liquidityNode(uint128 tick) external view returns (NodeInfo memory);

    /**
     * Get liquidity node with accrual info at tick
     * @param tick Tick
     * @return Liquidity node, Accrual info
     */
    function liquidityNodeWithAccrual(uint128 tick) external view returns (NodeInfo memory, AccrualInfo memory);

    /**
     * @notice Get deposit share price
     * @param tick Tick
     * @return Deposit share price
     */
    function depositSharePrice(uint128 tick) external view returns (uint256);

    /**
     * @notice Get redemption share price
     * @param tick Tick
     * @return Redemption share price
     */
    function redemptionSharePrice(uint128 tick) external view returns (uint256);
}
