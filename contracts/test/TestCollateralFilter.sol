// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.17;

import "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

import "../interfaces/ICollateralFilter.sol";

contract TestCollateralFilter is ICollateralFilter {
    using EnumerableSet for EnumerableSet.AddressSet;

    /**
     * @notice set of supported tokens
     */
    EnumerableSet.AddressSet private _tokens;

    /**
     * @notice Test Collateral Filter Constructor
     * @param tokens_ Supported tokens
     */
    constructor(address[] memory tokens_) {
        for (uint i = 0; i < tokens_.length; i++) {
            _tokens.add(tokens_[i]);
        }
    }

    /**
     * @inheritdoc ICollateralFilter
     */
    function name() external view returns (string memory) {
        return "Test Collateral Filter";
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
    function supported(address token, uint256 tokenId, bytes memory tokenIdSpec) external view returns (bool) {
        return _tokens.contains(token);
    }
}
