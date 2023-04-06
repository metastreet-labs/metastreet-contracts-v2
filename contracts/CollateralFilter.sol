// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/**
 * @title Collateral Filter API
 */
abstract contract CollateralFilter {
    /**
     * Query if collateral token is supported
     * @param token Collateral token contract
     * @param tokenId Collateral Token ID
     * @param context ABI-encoded context
     * @return True if supported, otherwise false
     */
    function collateralSupported(
        address token,
        uint256 tokenId,
        bytes memory context
    ) public view virtual returns (bool);
}
