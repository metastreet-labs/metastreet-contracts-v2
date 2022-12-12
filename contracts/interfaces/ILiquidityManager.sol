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
     * @notice Liquidity node
     * @param amount Total liquidity amount
     * @param shares Total liquidity shares outstanding
     * @param available Liquidity available
     * @param pending Liquidity pending (with interest)
     * @param redemptionPending Redemption pending amount
     * @param redemptionProcessed Redemption processed counter
     * @param prev Previous liquidity node
     * @param next Next liquidity node
     */
    struct LiquidityNode {
        uint128 amount;
        uint128 shares;
        uint128 available;
        uint128 pending;
        uint128 redemptionPending;
        uint128 redemptionProcessed;
        uint128 prev;
        uint128 next;
    }

    /**************************************************************************/
    /* API */
    /**************************************************************************/

    /**
     * Get utilization
     * @return Utilization (fixed-point)
     */
    function utilization() external view returns (uint256);

    /**
     * Get liquidity available at depth
     * @param depth Loan limit depth
     * @return Amount available
     */
    function liquidityAvailableAtDepth(
        uint256 depth
    ) external view returns (uint256 amount);

    /**
     * Get liquidity node at depth
     * @param depth Loan limit depth
     * @return Liquidity node
     */
    function liquidityNodeAtDepth(
        uint256 depth
    ) external view returns (LiquidityNode memory);

    /**
     * Get liquidity nodes across [beginDepth, endDepth] range
     * @param beginDepth Loan limit begin depth
     * @param endDepth Loan limit end depth
     * @return Liquidity nodes
     */
    function liquidityNodes(
        uint256 beginDepth,
        uint256 endDepth
    ) external view returns (LiquidityNode[] memory);
}
