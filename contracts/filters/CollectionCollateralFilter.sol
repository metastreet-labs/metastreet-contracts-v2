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
     * @notice Initialized boolean
     */
    bool private _initialized;

    /**
     * @notice Supported token
     */
    address private _token;

    /**************************************************************************/
    /* Constructor */
    /**************************************************************************/

    /**
     * @notice CollectionCollateralFilter constructor
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
    function initialize(bytes memory params) external {
        require(!_initialized, "Already initialized");

        _initialized = true;
        _token = abi.decode(params, (address));
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
    function supported(address token, uint256, bytes calldata) external view returns (bool) {
        return token == _token;
    }
}
