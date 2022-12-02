// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "./ILiquidityManager.sol";

/**
 * @title Interface to an Interest Rate Model
 */
interface IInterestRateModel {
    function name() external view returns (string memory);

    function priceLiquidity(
        ILiquidityManager.LiquidityNode[] memory nodes,
        uint256 amount,
        uint256 duration,
        uint256 maxDuration
    ) external view returns (uint256[] memory interest);
}
