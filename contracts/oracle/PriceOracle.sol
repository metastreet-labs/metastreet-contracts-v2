// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.25;

/**
 * @title Price oracle API
 * @author MetaStreet Labs
 */
abstract contract PriceOracle {
    /**************************************************************************/
    /* API */
    /**************************************************************************/

    /**
     * @notice Fetch price of token IDs
     * @param collateralToken Collateral token
     * @param currencyToken Currency token
     * @param tokenIds Token IDs
     * @param tokenIdQuantities Token ID quantities
     * @param oracleContext Oracle context
     * @return Token price in the same decimals as currency token
     */
    function price(
        address collateralToken,
        address currencyToken,
        uint256[] memory tokenIds,
        uint256[] memory tokenIdQuantities,
        bytes calldata oracleContext
    ) public view virtual returns (uint256);
}
