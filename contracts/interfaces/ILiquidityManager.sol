// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/**
 * @title Interface to the Liquidity Manager
 */
interface ILiquidityManager {
    /**************************************************************************/
    /* Structures */
    /**************************************************************************/

    /**
     * @notice Liquidity source
     * @param depth Sourced depth
     * @param used Sourced amount
     * @param pending Pending amount
     */
    struct LiquiditySource {
        uint128 depth;
        uint128 used;
        uint128 pending;
    }

    /**
     * @notice Flattened liquidity node returned by getter
     * @param depth Depth
     * @param value Total liquidity value
     * @param shares Total liquidity shares outstanding
     * @param available Liquidity available
     * @param pending Liquidity pending (with interest)
     * @param redemptions Total pending redemptions
     * @param prev Previous liquidity node
     * @param next Next liquidity node
     */
    struct LiquidityNodeInfo {
        uint128 depth;
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
     * Get utilization of liquidity
     * @return Utilization (fixed-point)
     */
    function utilization() external view returns (uint256);

    /**
     * Get liquidity available
     * @param maxDepth Max depth
     * @return Liquidity available
     */
    function liquidityAvailable(uint256 maxDepth) external view returns (uint256);

    /**
     * Get liquidity nodes across [beginDepth, endDepth] range
     * @param beginDepth Loan limit begin depth
     * @param endDepth Loan limit end depth
     * @return Liquidity nodes
     */
    function liquidityNodes(uint256 beginDepth, uint256 endDepth) external view returns (LiquidityNodeInfo[] memory);

    /**
     * Get liquidity solvency status at depth
     * @param depth Depth
     * @return True if liquidity is solvent, false otherwise
     */
    function liquidityNodeIsSolvent(uint256 depth) external view returns (bool);

    /**
     * Get liquidity active status at depth
     * @param depth Depth
     * @return True if liquidity is active, false otherwise
     */
    function liquidityNodeIsActive(uint256 depth) external view returns (bool);
}
