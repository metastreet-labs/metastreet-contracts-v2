// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/**
 * @title Interface to a Collateral Filter
 */
interface ICollateralFilter {
    /**
     * Get collateral filter name
     * @return Collateral filter name
     */
    function name() external view returns (string memory);

    /**
     * Get collateral token
     * @return Collateral token
     */
    function token() external view returns (address);

    /**
     * Query if token ID is supported
     * @return True if supported, otherwise false
     */
    function tokenIdSupported(
        uint256 tokenId,
        bytes memory tokenIdSpec
    ) external view returns (bool);
}
