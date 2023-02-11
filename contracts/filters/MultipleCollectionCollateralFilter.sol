// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.17;

import "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

import "../interfaces/ICollateralFilter.sol";

/**
 * @title Multiple Collection Collateral Filter
 * @author MetaStreet Labs
 */
contract MultipleCollectionCollateralFilter is ICollateralFilter {
    using EnumerableSet for EnumerableSet.AddressSet;

    /**************************************************************************/
    /* State */
    /**************************************************************************/

    /**
     * @notice Initialized boolean
     */
    bool private _initialized;

    /**
     * @notice Supported token set
     */
    EnumerableSet.AddressSet private _tokens;

    /**************************************************************************/
    /* Constructor */
    /**************************************************************************/

    /**
     * @notice MultipleCollectionCollateralFilter constructor
     */
    constructor() {
        /* Disable initialization of implementation contract */
        _initialized = true;
    }

    /**************************************************************************/
    /* Initializer */
    /**************************************************************************/

    /**
     * @notice Initializer
     * @param params ABI-encoded parameters
     */
    function initialize(bytes calldata params) external {
        require(!_initialized, "Already initialized");

        address[] memory tokens_ = abi.decode(params, (address[]));
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
        return "MultipleCollectionCollateralFilter";
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
