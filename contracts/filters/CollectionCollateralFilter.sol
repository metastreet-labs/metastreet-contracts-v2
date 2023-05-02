// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.17;

import "../CollateralFilter.sol";

/**
 * @title Collection Collateral Filter
 * @author MetaStreet Labs
 */
contract CollectionCollateralFilter is CollateralFilter {
    /**************************************************************************/
    /* Constants */
    /**************************************************************************/

    /**
     * @notice Collateral filter name
     */
    string public constant COLLATERAL_FILTER_NAME = "CollectionCollateralFilter";

    /**
     * @notice Collateral filter version
     */
    string public constant COLLATERAL_FILTER_VERSION = "1.0";

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
    /* Getters */
    /**************************************************************************/

    /**
     * @notice Get collateral token
     * @return Collateral token contract
     */
    function collateralToken() external view returns (address) {
        return _token;
    }

    /**************************************************************************/
    /* Implementation */
    /**************************************************************************/

    /**
     * @inheritdoc CollateralFilter
     */
    function collateralSupported(address token, uint256, bytes calldata) public view override returns (bool) {
        return token == _token;
    }
}
