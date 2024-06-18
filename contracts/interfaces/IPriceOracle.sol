// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/**
 * @title Interface to a Price Oracle
 */
interface IPriceOracle {
    /**
     * @notice Fetch price of token IDs
     * @param collateralToken Pool collateral token
     * @param currencyToken Pool currency token
     * @param tokenIds Token IDs
     * @param tokenIdQuantities Token ID quantities
     * @param oracleContext Oracle context
     * @return price Token price in the same decimals as currency token
     */
    function price(
        address collateralToken,
        address currencyToken,
        uint256[] memory tokenIds,
        uint256[] memory tokenIdQuantities,
        bytes calldata oracleContext
    ) external view returns (uint256 price);
}
