// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.20;

import "../Pool.sol";
import "../rates/WeightedInterestRateModel.sol";
import "../filters/MerkleCollectionCollateralFilter.sol";

/**
 * @title Pool Configuration with a Weighted Interest Rate Model and Ranged Collection
 * Collateral Filter
 * @author MetaStreet Labs
 */
contract WeightedRateMerkleCollectionPool is Pool, WeightedInterestRateModel, MerkleCollectionCollateralFilter {
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
     * @param depositPremiumRate Deposit premium rate in basis points
     * @param collateralLiquidator Collateral liquidator
     * @param delegationRegistry Delegation registry contract
     * @param collateralWrappers Collateral wrappers
     * @param parameters WeightedInterestRateModel parameters
     */
    constructor(
        uint256 depositPremiumRate,
        address collateralLiquidator,
        address delegationRegistry,
        address[] memory collateralWrappers,
        WeightedInterestRateModel.Parameters memory parameters
    )
        Pool(depositPremiumRate, collateralLiquidator, delegationRegistry, collateralWrappers)
        WeightedInterestRateModel(parameters)
    {
        /* Disable initialization of implementation contract */
        _initialized = true;
    }

    /**************************************************************************/
    /* Initializer */
    /**************************************************************************/

    function initialize(bytes memory params) external {
        require(!_initialized, "Already initialized");

        _initialized = true;

        /* Decode parameters */
        (
            address collateralToken_,
            address currencyToken_,
            uint64[] memory durations_,
            uint64[] memory rates_,
            bytes32 merkleRoot_,
            uint32 nodeCount_,
            string memory metadataURI_
        ) = abi.decode(params, (address, address, uint64[], uint64[], bytes32, uint32, string));

        /* Initialize Pool */
        Pool._initialize(currencyToken_, durations_, rates_);

        /* Initialize Collateral Filter */
        MerkleCollectionCollateralFilter._initialize(collateralToken_, merkleRoot_, nodeCount_, metadataURI_);
    }

    /**************************************************************************/
    /* Name */
    /**************************************************************************/

    /**
     * @inheritdoc Pool
     */
    function IMPLEMENTATION_NAME() external pure override returns (string memory) {
        return "WeightedRateMerkleCollectionPool";
    }
}
