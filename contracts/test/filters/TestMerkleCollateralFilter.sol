// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.20;

import "../../filters/MerkleCollateralFilter.sol";

/**
 * @title Test Contract Wrapper for MerkleCollateralFilter
 * @author MetaStreet Labs
 */
contract TestMerkleCollateralFilter is MerkleCollateralFilter {
    /**************************************************************************/
    /* Constructor */
    /**************************************************************************/

    constructor(address token, bytes memory params) {
        _initialize(token, params);
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
