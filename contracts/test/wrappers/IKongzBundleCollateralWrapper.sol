// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "../../interfaces/ICollateralWrapper.sol";

/**
 * @title Interface to KongzBundleCollateralWrapper
 */
interface IKongzBundleCollateralWrapper is ICollateralWrapper {
    function mint(uint256[] calldata tokenIds) external returns (uint256);

    function claim(uint256 tokenId, bytes calldata context) external;

    function claimable(uint256 tokenId, bytes calldata context) external view returns (uint256);
}
