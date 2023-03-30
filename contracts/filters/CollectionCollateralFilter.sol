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
     * @notice Implementation version
     */
    string public constant CF_IMPLEMENTATION_VERSION = "1.0";

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
