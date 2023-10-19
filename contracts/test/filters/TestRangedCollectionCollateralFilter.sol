// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.20;

import "../../filters/RangedCollectionCollateralFilter.sol";

/**
 * @title Test Contract Wrapper for RangedCollectionCollateralFilter
 * @author MetaStreet Labs
 */
contract TestRangedCollectionCollateralFilter is RangedCollectionCollateralFilter {
    /**************************************************************************/
    /* Constructor */
    /**************************************************************************/

    constructor(address token, uint256 startTokenId, uint256 endTokenId) {
        _initialize(token, startTokenId, endTokenId);
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
