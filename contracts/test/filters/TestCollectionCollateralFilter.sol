// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.17;

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
}
