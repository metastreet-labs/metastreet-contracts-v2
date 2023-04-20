// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/**
 * @title Interface to Liquidity state
 */
interface ILiquidity {
    /**************************************************************************/
    /* Structures */
    /**************************************************************************/

    /**
     * @notice Node source
     * @param tick Tick
     * @param available Available amount
     * @param used Used amount
     */
    struct NodeSource {
        uint128 tick;
        uint128 available;
        uint128 used;
    }

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

    /**************************************************************************/
    /* API */
    /**************************************************************************/

    /**
     * Get liquidity utilization
     * @return Utilization as 18-decimal fixed-point fraction
     */
    function utilization() external view returns (uint256);

    /**
     * Get liquidity statistics
     * @return total Total liquidity value
     * @return used Total liquidity used
     * @return numNodes Total liquidity nodes
     */
    function liquidityStatistics() external view returns (uint256 total, uint256 used, uint16 numNodes);

    /**
     * Get liquidity available up to max tick
     * @param maxTick Max tick
     * @param multiplier Multiplier in amount
     * @return Liquidity available
     */
    function liquidityAvailable(uint128 maxTick, uint256 multiplier) external view returns (uint256);

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
}
