// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/**
 * @title Collateral Filter API
 * @author MetaStreet Labs
 */
abstract contract CollateralFilter {
    /**************************************************************************/
    /* Errors */
    /**************************************************************************/

    /**
     * @notice Invalid parameters
     */
    error InvalidCollateralFilterParameters();

    /**
     * @notice Unsupported collateral
     */
    error UnsupportedCollateral();

    /**************************************************************************/
    /* API */
    /**************************************************************************/

    /**
     * @notice Get collateral filter name
     * @return Collateral filter name
     */
    function COLLATERAL_FILTER_NAME() external view virtual returns (string memory);

    /**
     * @notice Get collateral filter version
     * @return Collateral filter version
     */
    function COLLATERAL_FILTER_VERSION() external view virtual returns (string memory);

    /**
     * @notice Get collateral token
     * @return Collateral token contract
     */
    function collateralToken() external view virtual returns (address);

    /**
     * Query if collateral token is supported
     * @param token Collateral token contract
     * @param tokenIds Collateral Token IDs
     * @param context ABI-encoded context
     */
    function _collateralSupported(
        address token,
        uint256[] memory tokenIds,
        bytes calldata context
    ) internal view virtual;
}
