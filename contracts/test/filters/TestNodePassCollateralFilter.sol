// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.25;

import "../../filters/NodePassCollateralFilter.sol";

/**
 * @title Test Contract Wrapper for NodePassCollateralFilter
 * @author MetaStreet Labs
 */
contract TestNodePassCollateralFilter is NodePassCollateralFilter {
    /**************************************************************************/
    /* Constructor */
    /**************************************************************************/

    constructor(address yieldPassMarket, address nodeToken) NodePassCollateralFilter(yieldPassMarket) {
        _initialize(nodeToken);
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
