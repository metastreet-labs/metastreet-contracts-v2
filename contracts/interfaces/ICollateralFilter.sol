// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/**
 * @title Interface to a Collateral Filter
 */
interface ICollateralFilter {
    function name() external view returns (string memory);

    function token() external view returns (address);

    function tokenIdSupported(
        uint256 tokenId,
        bytes memory tokenIdSpec
    ) external view returns (bool);
}
