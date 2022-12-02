// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/**
 * @title Interface to the Liquidity Manager
 */
interface ILiquidityManager {
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

    function utilization() external view returns (uint256);

    function liquidityAmountAtDepth(
        uint256 depth
    ) external view returns (uint256 amount);

    function liquidityNodeAtDepth(
        uint256 depth
    ) external view returns (LiquidityNode memory);

    function liquidityNodes(
        uint256 beginDepth,
        uint256 endDepth
    ) external view returns (LiquidityNode[] memory);
}
