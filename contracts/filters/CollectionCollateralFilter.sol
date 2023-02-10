// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.17;

import "../interfaces/ICollateralFilter.sol";

/**
 * @title Collection Collateral Filter
 * @author MetaStreet Labs
 */
contract CollectionCollateralFilter is ICollateralFilter {
    /**************************************************************************/
    /* State */
    /**************************************************************************/

    /**
     * @notice Supported token
     */
    address private _token;

    /**************************************************************************/
    /* Constructor */
    /**************************************************************************/

    /**
     * @notice CollectionCollateralFilter constructor
     * @param token Supported token
     */
    constructor(address token) {
        _token = token;
    }

    /**************************************************************************/
    /* Implementation */
    /**************************************************************************/

    /**
     * @inheritdoc ICollateralFilter
     */
    function name() external pure returns (string memory) {
        return "CollectionCollateralFilter";
    }

    /**
     * @inheritdoc ICollateralFilter
     */
    function tokens() external view returns (address[] memory) {
        address[] memory tokenList = new address[](1);
        tokenList[0] = _token;
        return tokenList;
    }

    /**
     * @inheritdoc ICollateralFilter
     */
    function supported(address token, uint256, bytes memory) external view returns (bool) {
        return token == _token;
    }
}
