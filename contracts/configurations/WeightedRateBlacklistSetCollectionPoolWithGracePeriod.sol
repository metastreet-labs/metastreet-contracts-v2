// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.25;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import "../Pool.sol";
import "../rates/WeightedInterestRateModel.sol";
import "../filters/BlacklistSetCollectionCollateralFilter.sol";
import "../tokenization/ERC20DepositToken.sol";
import "../oracle/ExternalPriceOracle.sol";

/**
 * @title Pool Configuration with a Weighted Interest Rate Model and 
 * Blacklist Set Collection Collateral Filter with Grace Period
 * @author MetaStreet Labs
 */
contract WeightedRateBlacklistSetCollectionPoolWithGracePeriod is
    Pool,
    WeightedInterestRateModel,
    BlacklistSetCollectionCollateralFilter,
    ERC20DepositToken,
    ExternalPriceOracle
{
    using EnumerableSet for EnumerableSet.UintSet;

    /**************************************************************************/
    /* Events */
    /**************************************************************************/

    /**
     * @notice Grace period updated
     * @param gracePeriodDuration Grace period duration
     * @param gracePeriodRate Grace period interest rate per second
     */
    event GracePeriodUpdated(uint256 gracePeriodDuration, uint256 gracePeriodRate);

    /**************************************************************************/
    /* State */
    /**************************************************************************/

    /**
     * @notice Grace period duration
     */
    uint256 internal _gracePeriodDuration;

    /**
     * @notice Grace period interest rate per second
     */
    uint256 internal _gracePeriodRate;

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
        /* Validate collateral wrappers */
        if (collateralWrappers.length != 1) revert InvalidParameters();
        if (
            keccak256(abi.encodePacked(ICollateralWrapper(collateralWrappers[0]).name())) !=
            keccak256("MetaStreet Bundle Collateral Wrapper")
        ) revert InvalidParameters();

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
            address collateralToken_,
            uint256[] memory tokenIds_,
            address currencyToken_,
            address priceOracle_,
            uint64[] memory durations_,
            uint64[] memory rates_,
            uint256 gracePeriodDuration_,
            uint256 gracePeriodRate_
        ) = abi.decode(params, (address, uint256[], address, address, uint64[], uint64[], uint256, uint256));

        /* Initialize Collateral Filter */
        BlacklistSetCollectionCollateralFilter._initialize(collateralToken_, tokenIds_);

        /* Initialize External Price Oracle */
        ExternalPriceOracle.__initialize(priceOracle_);

        /* Initialize Pool */
        Pool._initialize(currencyToken_, durations_, rates_);

        /* Set grace period */
        _gracePeriodDuration = gracePeriodDuration_;
        _gracePeriodRate = gracePeriodRate_;
    }

    /**************************************************************************/
    /* Overrides */
    /**************************************************************************/

    /**
     * @inheritdoc Pool
     */
    function gracePeriodDuration() public override view returns (uint256) {
        return _gracePeriodDuration;
    }

    /**
     * @inheritdoc Pool
     */
    function gracePeriodRate() public override view returns (uint256) {
        return _gracePeriodRate;
    }

    /**
     * @inheritdoc Pool
     */
    function _liquidateCollateral(
        address collateralToken,
        uint256 collateralTokenId,
        bytes memory collateralWrapperContext,
        bytes calldata encodedLoanReceipt
    ) internal override {
        /* Check collateral token is bundle collateral wrapper */
        if (collateralToken == _collateralWrapper1) {
            /* Enumerate underlying collateral token IDs */
            (, uint256[] memory underlyingCollateralTokenIds) = ICollateralWrapper(_collateralWrapper1).enumerate(
                collateralTokenId,
                collateralWrapperContext
            );

            /* Add each underlying collateral token ID to set of unsupported token IDs */
            for (uint256 i; i < underlyingCollateralTokenIds.length; i++) {
                _tokenIds.add(underlyingCollateralTokenIds[i]);
            }
        } else {
            /* Add collateral token ID to set of unsupported token IDs */
            _tokenIds.add(collateralTokenId);
        }

        /* Liquidate collateral */
        super._liquidateCollateral(collateralToken, collateralTokenId, collateralWrapperContext, encodedLoanReceipt);
    }

    /**************************************************************************/
    /* Name */
    /**************************************************************************/

    /**
     * @inheritdoc Pool
     */
    function IMPLEMENTATION_NAME() external pure override returns (string memory) {
        return "WeightedRateBlacklistSetCollectionPoolWithGracePeriod";
    }

    /**************************************************************************/
    /* Admin API */
    /**************************************************************************/

    /**
     * @notice Set grace period
     * @param gracePeriodDuration_ Grace period duration
     * @param gracePeriodRate_ Grace period interest rate per second
     */
    function setGracePeriod(uint256 gracePeriodDuration_, uint256 gracePeriodRate_) external {
        /* Validate caller is pool admin */
        if (msg.sender != _storage.admin) revert IPool.InvalidCaller();

        /* Update grace period */
        _gracePeriodDuration = gracePeriodDuration_;
        _gracePeriodRate = gracePeriodRate_;

        /* Emit Grace Period Updated */
        emit GracePeriodUpdated(gracePeriodDuration_, gracePeriodRate_);
    }
}
