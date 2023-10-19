// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.20;

import "../../filters/MerkleCollectionCollateralFilter.sol";

/**
 * @title Test Contract Wrapper for MerkleCollectionCollateralFilter
 * @author MetaStreet Labs
 */
contract TestMerkleCollectionCollateralFilter is MerkleCollectionCollateralFilter {
    /**************************************************************************/
    /* Constructor */
    /**************************************************************************/

    constructor(address token, bytes32 root, uint32 nodeCount, string memory metadataURI) {
        _initialize(token, root, nodeCount, metadataURI);
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
