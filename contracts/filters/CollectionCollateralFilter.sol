// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.25;

import "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

import "./CollateralFilter.sol";

/**
 * @title Collection Collateral Filter
 * @author MetaStreet Labs
 */
contract CollectionCollateralFilter is CollateralFilter {
    using EnumerableSet for EnumerableSet.AddressSet;

    /**************************************************************************/
    /* State */
    /**************************************************************************/

    /**
     * @notice Supported token
     */
    address private _token;

    /**
     * @notice Set of supported aliases
     */
    EnumerableSet.AddressSet private _aliases;

    /**************************************************************************/
    /* Initializer */
    /**************************************************************************/

    /**
     * @notice CollectionCollateralFilter initializer
     */
    function _initialize(address[] memory tokens) internal {
        if (tokens.length == 0) revert InvalidCollateralFilterParameters();

        _token = tokens[0];

        for (uint256 i = 1; i < tokens.length; i++) {
            _aliases.add(tokens[i]);
        }
    }

    /**************************************************************************/
    /* Implementation */
    /**************************************************************************/

    /**
     * @inheritdoc CollateralFilter
     */
    function COLLATERAL_FILTER_NAME() external pure override returns (string memory) {
        return "CollectionCollateralFilter";
    }

    /**
     * @inheritdoc CollateralFilter
     */
    function COLLATERAL_FILTER_VERSION() external pure override returns (string memory) {
        return "1.0";
    }

    /**
     * @inheritdoc CollateralFilter
     */
    function collateralToken() public view override returns (address) {
        return _token;
    }

    /**
     * @inheritdoc CollateralFilter
     */
    function collateralTokens() external view override returns (address[] memory) {
        address[] memory aliases = _aliases.values();
        address[] memory tokens = new address[](1 + aliases.length);

        /* Assign collateral token to first index in array */
        tokens[0] = _token;

        /* Fill the array with aliases */
        for (uint256 i; i < aliases.length; i++) {
            tokens[i + 1] = aliases[i];
        }

        return tokens;
    }

    /**
     * @inheritdoc CollateralFilter
     */
    function _collateralSupported(
        address token,
        uint256,
        uint256,
        bytes calldata
    ) internal view override returns (bool) {
        return token == _token || _aliases.contains(token);
    }
}
