// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "./interfaces/ILiquidity.sol";

/**
 * @title Interest Rate Model API
 */
abstract contract InterestRateModel {
    /**
     * Get interest rate
     * @return Interest per second
     */
    function rate() public view virtual returns (uint256);

    /**
     * Distribute amount and interest to liquidity
     * @param amount Liquidity amount
     * @param interest Interest to distribute
     * @param nodes Liquidity nodes
     * @param count Liquidity node count
     * @return Interest distribution
     */
    function distribute(
        uint256 amount,
        uint256 interest,
        ILiquidity.NodeSource[] memory nodes,
        uint16 count
    ) public view virtual returns (uint128[] memory);

    /**
     * Utilization updated handler
     * @param utilization Utilization as a fixed-point, 18 decimal fraction
     */
    function _onUtilizationUpdated(uint256 utilization) internal virtual;
}
