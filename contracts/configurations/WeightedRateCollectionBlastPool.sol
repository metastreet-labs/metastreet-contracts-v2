// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.20;

import "../Pool.sol";
import "../rates/WeightedInterestRateModel.sol";
import "../filters/CollectionCollateralFilter.sol";
import "../tokenization/ERC20DepositToken.sol";

import "../integrations/Blast/IBlastPoints.sol";

/**
 * @title Pool Configuration with a Weighted Interest Rate Model, Collection
 * Collateral Filter, and Blast Points support
 * @author MetaStreet Labs
 */
contract WeightedRateCollectionBlastPool is Pool, WeightedInterestRateModel, CollectionCollateralFilter, ERC20DepositToken {
    /**************************************************************************/
    /* State */
    /**************************************************************************/

    /**
     * @notice Initialized boolean
     */
    bool private _initialized;

    /**************************************************************************/
    /* Immutable State */
    /**************************************************************************/

    /**
     * @notice Blast Points Contract
     */
    address internal immutable _blastPoints;

    /**
     * @notice Blast Points Operator
     */
    address internal immutable _blastPointsOperator;

    /**************************************************************************/
    /* Constructor */
    /**************************************************************************/

    /**
     * @notice Pool constructor
     * @param collateralLiquidator Collateral liquidator
     * @param delegateRegistryV1 Delegation registry v1 contract
     * @param delegateRegistryV2 Delegation registry v2 contract
     * @param blastPoints Blast points contract
     * @param blastPointsOperator Blast points operator
     * @param erc20DepositTokenImplementation ERC20 Deposit Token implementation address
     * @param collateralWrappers Collateral wrappers
     */
    constructor(
        address collateralLiquidator,
        address delegateRegistryV1,
        address delegateRegistryV2,
        address blastPoints,
        address blastPointsOperator,
        address erc20DepositTokenImplementation,
        address[] memory collateralWrappers
    )
        Pool(collateralLiquidator, delegateRegistryV1, delegateRegistryV2, collateralWrappers)
        WeightedInterestRateModel()
        ERC20DepositToken(erc20DepositTokenImplementation)
    {
        /* Disable initialization of implementation contract */
        _initialized = true;

        /* Configure blast points addresses */
        _blastPoints = blastPoints;
        _blastPointsOperator = blastPointsOperator;
    }

    /**************************************************************************/
    /* Initializer */
    /**************************************************************************/

    /**
     * @notice Initializer
     * @dev Fee-on-transfer currency tokens are not supported
     * @param params ABI-encoded parameters
     */
    function initialize(bytes memory params) external {
        require(!_initialized, "Already initialized");

        _initialized = true;

        /* Decode parameters */
        (address collateralToken_, address currencyToken_, uint64[] memory durations_, uint64[] memory rates_) = abi
            .decode(params, (address, address, uint64[], uint64[]));

        /* Initialize Collateral Filter */
        CollectionCollateralFilter._initialize(collateralToken_);

        /* Initialize Pool */
        Pool._initialize(currencyToken_, durations_, rates_);

        /* Configure Blast Points Operator */
        IBlastPoints(_blastPoints).configurePointsOperator(_blastPointsOperator);
    }

    /**************************************************************************/
    /* Name */
    /**************************************************************************/

    /**
     * @inheritdoc Pool
     */
    function IMPLEMENTATION_NAME() external pure override returns (string memory) {
        return "WeightedRateCollectionBlastPool";
    }
}
