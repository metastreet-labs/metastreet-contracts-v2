// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.17;

import "../CollateralFilter.sol";

/**
 * @title Collection Collateral Filter
 * @author MetaStreet Labs
 */
contract CollectionCollateralFilter is CollateralFilter {
    /**************************************************************************/
    /* State */
    /**************************************************************************/

    /**
     * @notice Supported token
     */
    address private _token;

    /**************************************************************************/
    /* Initializer */
    /**************************************************************************/

    /**
     * @notice CollectionCollateralFilter initializer
     */
    function _initialize(address token) internal {
        _token = token;
    }

    /**************************************************************************/
    /* Implementation */
    /**************************************************************************/

    /**
     * @inheritdoc CollateralFilter
     */
    function collateralFilter() external pure override returns (string memory) {
        return "CollectionCollateralFilter";
    }

    /**
     * @inheritdoc CollateralFilter
     */
    function collateralSupported(address token, uint256, bytes memory) public view override returns (bool) {
        return token == _token;
    }
}
