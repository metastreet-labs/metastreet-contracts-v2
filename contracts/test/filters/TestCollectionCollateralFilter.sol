// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.25;

import "../../filters/CollectionCollateralFilter.sol";

/**
 * @title Test Contract Wrapper for CollectionCollateralFilter
 * @author MetaStreet Labs
 */
contract TestCollectionCollateralFilter is CollectionCollateralFilter {
    /**************************************************************************/
    /* Constructor */
    /**************************************************************************/

    constructor(address[] memory tokens) {
        _initialize(tokens);
    }

    /**************************************************************************/
    /* Wrapper for Primary API */
    /**************************************************************************/

    /**
     * @dev External wrapper function for _collateralSupported
     */
    function collateralSupported(
        address token,
        uint256 tokenId,
        uint256 index,
        bytes calldata context
    ) external view returns (bool) {
        return _collateralSupported(token, tokenId, index, context);
    }
}
