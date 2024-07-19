// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.25;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import "../Pool.sol";
import "../rates/WeightedInterestRateModel.sol";
import "../filters/MerkleCollectionCollateralFilter.sol";
import "../tokenization/ERC20DepositToken.sol";
import "../oracle/ExternalPriceOracle.sol";

/**
 * @title Pool Configuration with a Weighted Interest Rate Model and Ranged Collection
 * Collateral Filter
 * @author MetaStreet Labs
 */
contract WeightedRateMerkleCollectionPool is
    Pool,
    WeightedInterestRateModel,
    MerkleCollectionCollateralFilter,
    ERC20DepositToken,
    ExternalPriceOracle
{
    /**************************************************************************/
    /* Constructor */
    /**************************************************************************/

    /**
     * @notice Pool constructor
     * @param collateralLiquidator Collateral liquidator
     * @param delegateRegistryV1 Delegation registry v1 contract
     * @param delegateRegistryV2 Delegation registry v2 contract
     * @param erc20DepositTokenImplementation ERC20 Deposit Token implementation address
     * @param collateralWrappers Collateral wrappers
     */
    constructor(
        address collateralLiquidator,
        address delegateRegistryV1,
        address delegateRegistryV2,
        address erc20DepositTokenImplementation,
        address[] memory collateralWrappers
    )
        Pool(collateralLiquidator, delegateRegistryV1, delegateRegistryV2, collateralWrappers)
        WeightedInterestRateModel()
        ERC20DepositToken(erc20DepositTokenImplementation)
        ExternalPriceOracle()
    {
        /* Disable initialization of implementation contract */
        _storage.currencyToken = IERC20(address(1));
    }

    /**************************************************************************/
    /* Initializer */
    /**************************************************************************/

    function initialize(bytes memory params) external {
        require(address(_storage.currencyToken) == address(0), "Already initialized");

        /* Decode parameters */
        (
            address collateralToken_,
            bytes32 merkleRoot_,
            uint32 nodeCount_,
            string memory metadataURI_,
            address currencyToken_,
            address priceOracle_,
            uint64[] memory durations_,
            uint64[] memory rates_
        ) = abi.decode(params, (address, bytes32, uint32, string, address, address, uint64[], uint64[]));

        /* Initialize Collateral Filter */
        MerkleCollectionCollateralFilter._initialize(collateralToken_, merkleRoot_, nodeCount_, metadataURI_);

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
    function IMPLEMENTATION_NAME() external pure override returns (string memory) {
        return "WeightedRateMerkleCollectionPool";
    }
}
