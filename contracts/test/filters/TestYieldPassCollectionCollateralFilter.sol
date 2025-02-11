// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.25;

import "../../filters/YieldPassCollectionCollateralFilter.sol";

/**
 * @title Test Contract Wrapper for YieldPassCollectionCollateralFilter
 * @author MetaStreet Labs
 */
contract TestYieldPassCollectionCollateralFilter is YieldPassCollectionCollateralFilter {
    /**************************************************************************/
    /* Constructor */
    /**************************************************************************/

    constructor(address yieldPassMarket, address nodeToken) {
        _initialize(yieldPassMarket, nodeToken);
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
