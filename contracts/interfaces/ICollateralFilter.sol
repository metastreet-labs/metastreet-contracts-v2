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
     * Query if collateral token is supported
     * @return True if supported, otherwise false
     */
    function supported(address token, uint256 tokenId, bytes memory tokenIdSpec) external view returns (bool);
}
