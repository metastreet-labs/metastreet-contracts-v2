// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.20;

import "../../filters/CollectionCollateralFilter.sol";

/**
 * @title Test Contract Wrapper for CollectionCollateralFilter
 * @author MetaStreet Labs
 */
contract TestCollectionCollateralFilter is CollectionCollateralFilter {
    /**************************************************************************/
    /* Constructor */
    /**************************************************************************/

    constructor(address token) {
        _initialize(token);
    }

    /**************************************************************************/
    /* Wrapper for Primary API */
    /**************************************************************************/

    /**
     * @dev External wrapper function for _collateralSupported
     */
    function collateralSupported(address token, uint256[] memory tokenIds, bytes calldata context) external view {
        _collateralSupported(token, tokenIds, context);
    }
}
