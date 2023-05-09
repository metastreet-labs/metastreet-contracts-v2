// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.19;

import "../Pool.sol";
import "../rates/WeightedInterestRateModel.sol";
import "../filters/RangedCollectionCollateralFilter.sol";

/**
 * @title Pool Configuration with a Weighted Interest Rate Model and Ranged Collection
 * Collateral Filter
 * @author MetaStreet Labs
 */
contract WeightedRateRangedCollectionPool is Pool, WeightedInterestRateModel, RangedCollectionCollateralFilter {
    /**************************************************************************/
    /* State */
    /**************************************************************************/

    /**
     * @notice Initialized boolean
     */
    bool private _initialized;

    /**************************************************************************/
    /* Constructor */
    /**************************************************************************/

    /**
     * @notice Pool constructor
     */
    constructor(
        address delegationRegistry_,
        address[] memory collateralWrappers,
        uint64 tickThreshold,
        uint64 tickExponential
    ) Pool(delegationRegistry_, collateralWrappers) WeightedInterestRateModel(tickThreshold, tickExponential) {
        /* Disable initialization of implementation contract */
        _initialized = true;
    }

    /**************************************************************************/
    /* Initializer */
    /**************************************************************************/

    /**
     * @notice Initializer
     * @dev Fee-on-transfer currency tokens are not supported
     */
    function initialize(bytes memory params, address collateralLiquidator_) external {
        require(!_initialized, "Already initialized");

        _initialized = true;

        /* Decode parameters */
        (
            address collateralToken_,
            address currencyToken_,
            uint64[] memory durations_,
            uint64[] memory rates_,
            uint256 startTokenId_,
            uint256 endTokenId_
        ) = abi.decode(params, (address, address, uint64[], uint64[], uint256, uint256));

        /* Initialize Pool */
        Pool._initialize(currencyToken_, collateralLiquidator_, durations_, rates_);

        /* Initialize Collateral Filter */
        RangedCollectionCollateralFilter._initialize(collateralToken_, abi.encode(startTokenId_, endTokenId_));
    }
}
