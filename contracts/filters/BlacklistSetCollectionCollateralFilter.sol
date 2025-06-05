// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.25;

import "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

import "./CollateralFilter.sol";

/**
 * @title Blacklist Set Collection Collateral Filter
 * @author MetaStreet Labs
 */
contract BlacklistSetCollectionCollateralFilter is CollateralFilter {
    using EnumerableSet for EnumerableSet.UintSet;

    /**************************************************************************/
    /* State */
    /**************************************************************************/

    /**
     * @notice Supported token
     */
    address private _token;

    /**
     * @notice Set of unsupported token IDs
     */
    EnumerableSet.UintSet internal _tokenIds;

    /**************************************************************************/
    /* Initializer */
    /**************************************************************************/

    /**
     * @notice BlacklistSetCollectionCollateralFilter initializer
     */
    function _initialize(address token, uint256[] memory tokenIds_) internal {
        /* Set unsupported token */
        _token = token;

        /* Add each token ID to set of unsupported token IDs */
        for (uint256 i; i < tokenIds_.length; i++) {
            _tokenIds.add(tokenIds_[i]);
        }
    }

    /**************************************************************************/
    /* Getters */
    /**************************************************************************/

    /**
     * @inheritdoc CollateralFilter
     */
    function COLLATERAL_FILTER_NAME() external pure override returns (string memory) {
        return "BlacklistSetCollectionCollateralFilter";
    }

    /**
     * @inheritdoc CollateralFilter
     */
    function COLLATERAL_FILTER_VERSION() external pure override returns (string memory) {
        return "1.0";
    }

    /**
     * @notice Get collateral token
     * @return Collateral token contract
     */
    function collateralToken() public view override returns (address) {
        return _token;
    }

    /**
     * @inheritdoc CollateralFilter
     */
    function collateralTokens() external view override returns (address[] memory) {
        address[] memory tokens = new address[](1);
        tokens[0] = _token;

        return tokens;
    }

    /**
     * @notice Get unsupported collateral token IDs
     * @return Unsupported collateral token IDs
     */
    function unsupportedCollateralTokenIds() external view returns (uint256[] memory) {
        return _tokenIds.values();
    }

    /**************************************************************************/
    /* Implementation */
    /**************************************************************************/

    /**
     * @inheritdoc CollateralFilter
     */
    function _collateralSupported(
        address token,
        uint256 tokenId,
        uint256,
        bytes calldata
    ) internal view override returns (bool) {
        /* Validate token supported */
        if (token != _token) return false;

        /* Validate token ID is not in set of token IDs */
        return !_tokenIds.contains(tokenId);
    }
}
