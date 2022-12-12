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
     * Price liquidity for a loan
     * @param nodes Liquidity nodes used
     * @param amount Loan amount
     * @param duration Loan duration
     * @param maxDuration Pool max duration
     * @return interest Interest for each liquidity node
     */
    function priceLiquidity(
        ILiquidityManager.LiquidityNode[] memory nodes,
        uint256 amount,
        uint256 duration,
        uint256 maxDuration
    ) external view returns (uint256[] memory interest);
}
