// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.25;

import "../Pool.sol";
import "../rates/WeightedInterestRateModel.sol";
import "../filters/CollectionCollateralFilter.sol";
import "../tokenization/ERC20DepositToken.sol";
import "../oracle/ExternalPriceOracle.sol";

import "../integrations/Blast/IBlast.sol";
import "../integrations/Blast/IERC20Rebasing.sol";

/**
 * @title Pool Configuration with a Weighted Interest Rate Model, Collection
 * Collateral Filter, and Blast Yield, Gas & Points support
 * @author MetaStreet Labs
 */
contract WeightedRateCollectionBlastPool is
    Pool,
    WeightedInterestRateModel,
    CollectionCollateralFilter,
    ERC20DepositToken,
    ExternalPriceOracle
{
    /**************************************************************************/
    /* Constants */
    /**************************************************************************/

    /**
     * @notice Blast Contract
     */
    IBlast internal immutable BLAST = IBlast(0x4300000000000000000000000000000000000002);

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

    /**
     * @notice Initializer
     * @dev Fee-on-transfer currency tokens are not supported
     * @param params ABI-encoded parameters
     */
    function initialize(bytes memory params) external {
        require(address(_storage.currencyToken) == address(0), "Already initialized");

        /* Decode parameters */
        (
            address[] memory collateralTokens_,
            address currencyToken_,
            address priceOracle_,
            uint64[] memory durations_,
            uint64[] memory rates_
        ) = abi.decode(params, (address[], address, address, uint64[], uint64[]));

        /* Initialize Collateral Filter */
        CollectionCollateralFilter._initialize(collateralTokens_);

        /* Initialize External Price Oracle */
        ExternalPriceOracle.__initialize(priceOracle_);

        /* Initialize Pool */
        Pool._initialize(currencyToken_, durations_, rates_);

        /* Set yield mode to claimable if currency token is Blast yield token */
        if (isBlastYieldToken(currencyToken_)) {
            IERC20Rebasing(currencyToken_).configure(YieldMode.CLAIMABLE);
        }

        /* Configure Blast Claimable Gas */
        BLAST.configureClaimableGas();

        /* Configure Blast Governor */
        BLAST.configureGovernor(_storage.admin);
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

    /**************************************************************************/
    /* Helpers */
    /**************************************************************************/

    /**
     * @notice Check if currency token is Blast yield token
     * @param currencyToken Currency token
     * @return True if currency token is Blast mainnet USDB / WETH or
     * Blast testnet sepolia USDB / WETH
     */
    function isBlastYieldToken(address currencyToken) internal view returns (bool) {
        return ((block.chainid == 81457 &&
            (currencyToken == 0x4300000000000000000000000000000000000003 ||
                currencyToken == 0x4300000000000000000000000000000000000004)) ||
            (block.chainid == 168587773 &&
                (currencyToken == 0x4200000000000000000000000000000000000022 ||
                    currencyToken == 0x4200000000000000000000000000000000000023)));
    }
}
