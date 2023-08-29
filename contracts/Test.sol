// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.20;

import "./interfaces/ICollateralWrapper2.sol";

import "hardhat/console.sol";

/**
 * @title Tick
 * @author MetaStreet Labs
 */
contract Test {
    function test(
        address collateralToken,
        uint256 collateralTokenId,
        bytes calldata collateralWrapperContext
    ) external view returns (address, uint256[] memory) {
        console.log("before enumerate");
        (address underlyingCollateralToken, uint256[] memory underlyingCollateralTokenIds) = ICollateralWrapper2(
            collateralToken
        ).enumerate(collateralTokenId, collateralWrapperContext);
        console.log("after enumerate");

        return (underlyingCollateralToken, underlyingCollateralTokenIds);
    }
}
