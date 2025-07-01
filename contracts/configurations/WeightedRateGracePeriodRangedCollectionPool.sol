// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.25;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import "../Pool.sol";
import "../rates/WeightedInterestRateModel.sol";
import "../filters/RangedCollectionCollateralFilter.sol";
import "../tokenization/ERC20DepositToken.sol";
import "../oracle/ExternalPriceOracle.sol";

/**
 * @title Pool Configuration with a Weighted Interest Rate Model, Grace Period
 * Support, and Ranged Collection Collateral Filter
 * @author MetaStreet Labs
 */
contract WeightedRateGracePeriodRangedCollectionPool is
    Pool,
    WeightedInterestRateModel,
    RangedCollectionCollateralFilter,
    ERC20DepositToken,
    ExternalPriceOracle
{
    /**************************************************************************/
    /* Constants */
    /**************************************************************************/

    /**
     * @notice Deposit whitelist storage location
     * @dev keccak256(abi.encode(uint256(keccak256("weightedRateGracePeriodRangedCollectionPool.depositWhitelist")) - 1)) & ~bytes32(uint256(0xff));
     */
    bytes32 internal constant DEPOSIT_WHITELIST_STORAGE_LOCATION =
        0xb3daf58d5c92be151ade1dcf694b7f8486281fd452dbd0443558efdfe1579600;

    /**************************************************************************/
    /* Structures */
    /**************************************************************************/

    /**
     * @notice Deposit whitelist
     * @custom:storage-location erc7201:weightedRateGracePeriodRangedCollectionPool.depositWhitelist
     * @param whitelist Mapping of tick to address to bool
     * @param depositAdmin Address of the deposit admin
     */
    struct DepositWhitelist {
        mapping(uint128 => mapping(address => bool)) whitelist;
        address depositAdmin;
    }

    /**************************************************************************/
    /* Events */
    /**************************************************************************/

    /**
     * @notice Grace period updated
     * @param gracePeriodDuration Grace period duration
     * @param gracePeriodRate Grace period interest rate per second
     */
    event GracePeriodUpdated(uint256 gracePeriodDuration, uint256 gracePeriodRate);

    /**
     * @notice Deposit whitelist updated
     * @param tick Tick
     * @param account Account
     * @param isWhitelisted True if account is whitelisted for tick
     */
    event DepositWhitelistUpdated(uint128 indexed tick, address indexed account, bool isWhitelisted);

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
            uint256 startTokenId_,
            uint256 endTokenId_,
            address currencyToken_,
            address priceOracle_,
            uint64[] memory durations_,
            uint64[] memory rates_,
            uint256 gracePeriodDuration_,
            uint256 gracePeriodRate_,
            address depositAdmin_
        ) = abi.decode(
                params,
                (address, uint256, uint256, address, address, uint64[], uint64[], uint256, uint256, address)
            );

        /* Initialize Collateral Filter */
        RangedCollectionCollateralFilter._initialize(collateralToken_, startTokenId_, endTokenId_);

        /* Initialize External Price Oracle */
        ExternalPriceOracle.__initialize(priceOracle_);

        /* Initialize Pool */
        Pool._initialize(currencyToken_, durations_, rates_);

        /* Set grace period */
        _gracePeriodDuration = gracePeriodDuration_;
        _gracePeriodRate = gracePeriodRate_;

        /* Set deposit admin */
        _getDepositWhitelistStorage().depositAdmin = depositAdmin_;
    }

    /**************************************************************************/
    /* Overrides */
    /**************************************************************************/

    /**
     * @inheritdoc Pool
     */
    function gracePeriodDuration() public view override returns (uint256) {
        return _gracePeriodDuration;
    }

    /**
     * @inheritdoc Pool
     */
    function gracePeriodRate() public view override returns (uint256) {
        return _gracePeriodRate;
    }

    /**
     * @inheritdoc Pool
     */
    function deposit(uint128 tick, uint256 amount, uint256 minShares) public override returns (uint256) {
        /* Validate caller is whitelisted for deposit at tick */
        if (!isDepositWhitelisted(msg.sender, tick)) revert IPool.InvalidCaller();

        return super.deposit(tick, amount, minShares);
    }

    /**
     * @inheritdoc Pool
     */
    function rebalance(
        uint128 srcTick,
        uint128 dstTick,
        uint128 redemptionId,
        uint256 minShares
    ) public override returns (uint256, uint256, uint256) {
        /* Validate caller is whitelisted for deposit at tick */
        if (!isDepositWhitelisted(msg.sender, dstTick)) revert IPool.InvalidCaller();

        return super.rebalance(srcTick, dstTick, redemptionId, minShares);
    }

    /**************************************************************************/
    /* Name */
    /**************************************************************************/

    /**
     * @inheritdoc Pool
     */
    function IMPLEMENTATION_NAME() external pure override returns (string memory) {
        return "WeightedRateGracePeriodRangedCollectionPool";
    }

    /**************************************************************************/
    /* Getters */
    /**************************************************************************/

    /**
     * @notice Check if account is whitelisted for deposit at tick
     * @param account Account
     * @param tick Tick
     * @return True if account is whitelisted, otherwise false
     */
    function isDepositWhitelisted(address account, uint128 tick) public view returns (bool) {
        return _getDepositWhitelistStorage().whitelist[tick][account];
    }

    /**************************************************************************/
    /* Storage Helper */
    /**************************************************************************/

    /**
     * @notice Get reference to deposit whitelist storage
     * @return $ Reference to deposit whitelist storage
     */
    function _getDepositWhitelistStorage() internal pure returns (DepositWhitelist storage $) {
        assembly {
            $.slot := DEPOSIT_WHITELIST_STORAGE_LOCATION
        }
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

    /**
     * @notice Set deposit whitelist
     * @param tick Tick
     * @param account Account
     * @param isWhitelisted Whether account is whitelisted for deposit at tick
     */
    function setDepositWhitelist(uint128 tick, address account, bool isWhitelisted) external {
        /* Validate caller is deposit admin */
        if (msg.sender != _getDepositWhitelistStorage().depositAdmin) revert IPool.InvalidCaller();

        /* Validate account is not zero address */
        if (account == address(0)) revert IPool.InvalidParameters();

        /* Validate tick is valid */
        if (tick == 0) revert IPool.InvalidParameters();

        /* Set deposit whitelist */
        _getDepositWhitelistStorage().whitelist[tick][account] = isWhitelisted;

        /* Emit DepositWhitelistUpdated */
        emit DepositWhitelistUpdated(tick, account, isWhitelisted);
    }
}
