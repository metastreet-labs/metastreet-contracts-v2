// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.20;

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
     * @notice Requires migration boolean
     */
    bool private _requiresMigration;

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
    function collateralToken() external view override returns (address) {
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

    /**************************************************************************/
    /* Migration */
    /**************************************************************************/

    /**
     * @notice Add Ͼ721 to WPUNKS collateral filter alias set and
     * set _requiresMigration, previously _initialized, to false
     * @dev This function is to be removed after migration
     */
    function migrate() external {
        require(_requiresMigration, "Already migrated");

        if (_token == 0xb7F7F6C52F2e2fdb1963Eab30438024864c313F6)
            _aliases.add(0x00000000000000343662D3FAD10D154530C0d4F1);

        _requiresMigration = false;
    }
}
