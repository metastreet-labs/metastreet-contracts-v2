// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.19;

import "../CollateralFilter.sol";

/**
 * @title Ranged Collection Collateral Filter
 * @author MetaStreet Labs
 */
contract RangedCollectionCollateralFilter is CollateralFilter {
    /**************************************************************************/
    /* Constants */
    /**************************************************************************/

    /**
     * @notice Collateral filter name
     */
    string public constant COLLATERAL_FILTER_NAME = "RangedCollectionCollateralFilter";

    /**
     * @notice Collateral filter version
     */
    string public constant COLLATERAL_FILTER_VERSION = "1.0";

    /**************************************************************************/
    /* Errors */
    /**************************************************************************/

    /**
     * @notice Invalid address
     */
    error InvalidRange();

    /**************************************************************************/
    /* State */
    /**************************************************************************/

    /**
     * @notice Supported token
     */
    address private _token;

    /**
     * @notice Supported start token ID (inclusive)
     */
    uint256 private _startTokenId;

    /**
     * @notice Supported end token ID (inclusive)
     */
    uint256 private _endTokenId;

    /**************************************************************************/
    /* Initializer */
    /**************************************************************************/

    /**
     * @notice RangedCollectionCollateralFilter initializer
     */
    function _initialize(address token, bytes memory params) internal {
        /* Decode parameters */
        (uint256 startTokenId, uint256 endTokenId) = abi.decode(params, (uint256, uint256));

        if (endTokenId < startTokenId) revert InvalidRange();

        _token = token;
        _startTokenId = startTokenId;
        _endTokenId = endTokenId;
    }

    /**************************************************************************/
    /* Getters */
    /**************************************************************************/

    /**
     * @notice Get collateral token
     * @return Collateral token contract
     */
    function collateralToken() external view override returns (address) {
        return _token;
    }

    /**
     * @notice Get collateral token ID range
     * @return Start token ID (inclusive)
     * @return End token ID (inclusive)
     */
    function collateralTokenIdRange() external view returns (uint256, uint256) {
        return (_startTokenId, _endTokenId);
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
        return token == _token && tokenId >= _startTokenId && tokenId <= _endTokenId;
    }
}
