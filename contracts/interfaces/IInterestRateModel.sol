// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "./ILiquidityManager.sol";

/**
 * @title Interface to an Interest Rate Model
 */
interface IInterestRateModel {
    /**
     * Get interest rate model name
     * @return Interest rate model name
     */
    function name() external view returns (string memory);

    /**
     * Calculate interest rate for liquidity
     * @param nodesUsed Number of nodes used
     * @param nodesTotal Number of nodes total
     * @return interestRate Interest per second
     */
    function calculateRate(uint16 nodesUsed, uint16 nodesTotal) external view returns (uint256 interestRate);

    /**
     * Distribute interest for liquidity
     * @param interest Interest to distribute
     * @param trail Liquidity trail
     */
    function distributeInterest(uint128 interest, ILiquidityManager.LiquiditySource[] memory trail) external view;

    /**
     * Utilization updated handler
     * @param utilization Utilization as a fixed-point, 18 decimal fraction
     */
    function onUtilizationUpdated(uint256 utilization) external;
}
