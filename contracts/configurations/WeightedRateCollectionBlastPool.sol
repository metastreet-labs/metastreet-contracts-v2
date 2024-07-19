// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.25;

import "../Pool.sol";
import "../rates/WeightedInterestRateModel.sol";
import "../filters/CollectionCollateralFilter.sol";
import "../tokenization/ERC20DepositToken.sol";
import "../oracle/ExternalPriceOracle.sol";

import "../integrations/Blast/IBlastPoints.sol";
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
    IBlast internal constant BLAST = IBlast(0x4300000000000000000000000000000000000002);

    /**
     * @notice Blast Points Contract (Testnet)
     */
    IBlastPoints internal constant BLAST_POINTS_TESTNET = IBlastPoints(0x2fc95838c71e76ec69ff817983BFf17c710F34E0);

    /**
     * @notice Blast Points Contract (Mainnet)
     */
    IBlastPoints internal constant BLAST_POINTS_MAINNET = IBlastPoints(0x2536FE9ab3F511540F2f9e2eC2A805005C3Dd800);

    /**************************************************************************/
    /* Immutable State */
    /**************************************************************************/

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
     * @param blastPointsOperator Blast points operator
     * @param erc20DepositTokenImplementation ERC20 Deposit Token implementation address
     * @param collateralWrappers Collateral wrappers
     */
    constructor(
        address collateralLiquidator,
        address delegateRegistryV1,
        address delegateRegistryV2,
        address blastPointsOperator,
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

        /* Set blast points operator */
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

        /* Configure Blast Points Operator */
        if (block.chainid == 81457) BLAST_POINTS_MAINNET.configurePointsOperator(_blastPointsOperator);
        else if (block.chainid == 168587773) BLAST_POINTS_TESTNET.configurePointsOperator(_blastPointsOperator);
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
