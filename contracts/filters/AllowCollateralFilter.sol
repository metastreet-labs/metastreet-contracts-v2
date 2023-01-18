// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.17;

import "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

import "../interfaces/ICollateralFilter.sol";

/**
 * @title Allow Collateral Filter
 * @author MetaStreet Labs
 */
contract AllowCollateralFilter is ICollateralFilter {
    using EnumerableSet for EnumerableSet.AddressSet;

    /**************************************************************************/
    /* State */
    /**************************************************************************/

    EnumerableSet.AddressSet private _tokens;

    /**************************************************************************/
    /* Constructor */
    /**************************************************************************/

    /**
     * @notice AllowCollateralFilter constructor
     * @notice tokens Supported tokens
     */
    constructor(address[] memory tokens_) {
        for (uint256 i; i < tokens_.length; i++) {
            _tokens.add(tokens_[i]);
        }
    }

    /**************************************************************************/
    /* Implementation */
    /**************************************************************************/

    /**
     * @inheritdoc ICollateralFilter
     */
    function name() external pure returns (string memory) {
        return "AllowCollateralFilter";
    }

    /**
     * @inheritdoc ICollateralFilter
     */
    function tokens() external view returns (address[] memory) {
        return _tokens.values();
    }

    /**
     * @inheritdoc ICollateralFilter
     */
    function supported(address token, uint256, bytes memory) external view returns (bool) {
        return _tokens.contains(token);
    }
}
