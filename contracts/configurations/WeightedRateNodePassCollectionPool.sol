// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.25;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import "../Pool.sol";
import "../rates/WeightedInterestRateModel.sol";
import "../filters/NodePassCollectionCollateralFilter.sol";
import "../tokenization/ERC20DepositToken.sol";
import "../oracle/ExternalPriceOracle.sol";

/**
 * @title Pool Configuration with a Weighted Interest Rate Model and Node Pass
 * Collection Collateral Filter
 * @author MetaStreet Labs
 */
contract WeightedRateNodePassCollectionPool is
    Pool,
    WeightedInterestRateModel,
    NodePassCollectionCollateralFilter,
    ERC20DepositToken,
    ExternalPriceOracle
{
    /**************************************************************************/
    /* Constructor */
    /**************************************************************************/

    /**
     * @notice Pool constructor
     * @param collateralLiquidator Collateral liquidator
     * @param delegateRegistryV2 Delegation registry v2 contract
     * @param yieldPassFactory Yield pass factory
     * @param erc20DepositTokenImplementation ERC20 Deposit Token implementation address
     * @param collateralWrappers Collateral wrappers
     */
    constructor(
        address collateralLiquidator,
        address delegateRegistryV2,
        address yieldPassFactory,
        address erc20DepositTokenImplementation,
        address[] memory collateralWrappers
    )
        Pool(collateralLiquidator, delegateRegistryV2, collateralWrappers)
        WeightedInterestRateModel()
        NodePassCollectionCollateralFilter(yieldPassFactory)
        ERC20DepositToken(erc20DepositTokenImplementation)
        ExternalPriceOracle()
    {
        /* Disable initialization of implementation contract */
        _storage.currencyToken = IERC20(address(1));
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
        require(address(_storage.currencyToken) == address(0), "Already initialized");

        /* Decode parameters */
        (
            address nodeToken_,
            address currencyToken_,
            address priceOracle_,
            uint64[] memory durations_,
            uint64[] memory rates_
        ) = abi.decode(params, (address, address, address, uint64[], uint64[]));

        /* Initialize Collateral Filter */
        NodePassCollectionCollateralFilter._initialize(nodeToken_);

        /* Initialize External Price Oracle */
        ExternalPriceOracle.__initialize(priceOracle_);

        /* Initialize Pool */
        Pool._initialize(currencyToken_, durations_, rates_);
    }

    /**************************************************************************/
    /* Name */
    /**************************************************************************/

    /**
     * @inheritdoc Pool
     */
    string public constant override IMPLEMENTATION_NAME = "WeightedRateNodePassCollectionPool";
}
