// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.20;

import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/introspection/ERC165.sol";
import "@openzeppelin/contracts/utils/Multicall.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@openzeppelin/contracts/utils/math/SafeCast.sol";

import "./filters/CollateralFilter.sol";
import "./rates/InterestRateModel.sol";
import "./tokenization/DepositToken.sol";

import "./LoanReceipt.sol";
import "./LiquidityLogic.sol";
import "./DepositLogic.sol";
import "./BorrowLogic.sol";

import "./interfaces/IPool.sol";
import "./interfaces/ILiquidity.sol";
import "./interfaces/ICollateralWrapper.sol";
import "./interfaces/ICollateralLiquidator.sol";
import "./interfaces/ICollateralLiquidationReceiver.sol";

/**
 * @title Pool
 * @author MetaStreet Labs
 */
abstract contract Pool is
    ERC165,
    ReentrancyGuard,
    Multicall,
    CollateralFilter,
    InterestRateModel,
    DepositToken,
    IPool,
    ILiquidity,
    ICollateralLiquidationReceiver
{
    using SafeCast for uint256;
    using SafeERC20 for IERC20;
    using LiquidityLogic for LiquidityLogic.Liquidity;

    /**************************************************************************/
    /* Constants */
    /**************************************************************************/

    /**
     * @notice Tick spacing basis points
     */
    uint256 public constant TICK_LIMIT_SPACING_BASIS_POINTS = LiquidityLogic.TICK_LIMIT_SPACING_BASIS_POINTS;

    /**
     * @notice Borrower's split of liquidation proceed surplus in basis points
     */
    uint256 public constant BORROWER_SURPLUS_SPLIT_BASIS_POINTS = BorrowLogic.BORROWER_SURPLUS_SPLIT_BASIS_POINTS;

    /**************************************************************************/
    /* Structures */
    /**************************************************************************/

    /**
     * @notice Redemption
     * @param pending Redemption shares pending
     * @param index Redemption queue index
     * @param target Redemption queue target
     */
    struct Redemption {
        uint128 pending;
        uint128 index;
        uint128 target;
    }

    /**
     * @notice Deposit
     * @param shares Shares
     * @param redemptionId Next Redemption ID
     * @param redemptions Mapping of redemption ID to redemption
     */
    struct Deposit {
        uint128 shares;
        uint128 redemptionId;
        mapping(uint128 => Redemption) redemptions;
    }

    /**
     * @notice Delegate
     * @param version Delegate version
     * @param to Delegate address
     */
    struct Delegate {
        DelegateVersion version;
        address to;
    }

    /**
     * @custom:storage-location erc7201:pool.delegateStorage
     */
    struct DelegateStorage {
        /* Mapping of collateralToken to token ID to Delegate */
        mapping(address => mapping(uint256 => Delegate)) delegates;
    }

    /**
     * @notice Loan status
     */
    enum LoanStatus {
        Uninitialized,
        Active,
        Repaid,
        Liquidated,
        CollateralLiquidated
    }

    /**
     * @notice Borrow function options
     */
    enum BorrowOptions {
        None,
        CollateralWrapperContext,
        CollateralFilterContext,
        DelegateCashV1,
        DelegateCashV2
    }

    /**
     * @notice Delegate version
     */
    enum DelegateVersion {
        None,
        DelegateCashV1,
        DelegateCashV2
    }

    /**************************************************************************/
    /* Immutable State */
    /**************************************************************************/

    /**
     * @notice Collateral wrappers (max 3)
     */
    address internal immutable _collateralWrapper1;
    address internal immutable _collateralWrapper2;
    address internal immutable _collateralWrapper3;

    /**
     * @notice Collateral liquidator
     */
    ICollateralLiquidator internal immutable _collateralLiquidator;

    /**
     * @notice Delegate registry v1 contract
     */
    address internal immutable _delegateRegistryV1;

    /**
     * @notice Delegate registry v2 contract
     */
    address internal immutable _delegateRegistryV2;

    /**
     * @notice Delegate cash storage slot
     * @dev keccak256(abi.encode(uint256(keccak256("erc7201:pool.delegateStorage")) - 1)) & ~bytes32(uint256(0xff));
     */
    bytes32 internal constant DELEGATE_STORAGE_LOCATION =
        0xf0e5094ebd597f2042580340ce53d1b15e5b64e0d8be717ecde51dd37c619300;

    /**************************************************************************/
    /* State */
    /**************************************************************************/

    /**
     * @notice Pool Storage
     * @param currencyToken Currency token contract
     * @param adminFeeRate Admin free rate in basis points
     * @param durations Durations
     * @param rates Rates
     * @param admin Admin
     * @param adminFeeBalance Admin fee balance
     * @param liquidity Liquidity
     * @param deposits Mapping of account to tick to deposit
     * @param loans Mapping of loan receipt hash to loan status
     */
    struct PoolStorage {
        IERC20 currencyToken;
        uint32 adminFeeRate;
        uint64[] durations;
        uint64[] rates;
        address admin;
        uint256 adminFeeBalance;
        LiquidityLogic.Liquidity liquidity;
        mapping(address => mapping(uint128 => Deposit)) deposits;
        mapping(bytes32 => LoanStatus) loans;
    }

    /**
     * @notice Pool state
     */
    PoolStorage internal _storage;

    /**************************************************************************/
    /* Constructor */
    /**************************************************************************/

    /**
     * @notice Pool constructor
     * @param collateralLiquidator_ Collateral liquidator
     * @param delegateRegistryV1_ Delegate registry v1 contract
     * @param delegateRegistryV2_ Delegate registry v2 contract
     * @param collateralWrappers_ Collateral wrappers
     */
    constructor(
        address collateralLiquidator_,
        address delegateRegistryV1_,
        address delegateRegistryV2_,
        address[] memory collateralWrappers_
    ) {
        if (collateralWrappers_.length > 3) revert InvalidParameters();

        _collateralLiquidator = ICollateralLiquidator(collateralLiquidator_);
        _delegateRegistryV1 = delegateRegistryV1_;
        _delegateRegistryV2 = delegateRegistryV2_;
        _collateralWrapper1 = (collateralWrappers_.length > 0) ? collateralWrappers_[0] : address(0);
        _collateralWrapper2 = (collateralWrappers_.length > 1) ? collateralWrappers_[1] : address(0);
        _collateralWrapper3 = (collateralWrappers_.length > 2) ? collateralWrappers_[2] : address(0);
    }

    /**************************************************************************/
    /* Initializer */
    /**************************************************************************/

    /**
     * @notice Pool initializer
     * @dev Fee-on-transfer currency tokens are not supported
     * @param currencyToken_ Currency token contract
     * @param durations_ Duration tiers
     * @param rates_ Interest rate tiers
     */
    function _initialize(address currencyToken_, uint64[] memory durations_, uint64[] memory rates_) internal {
        if (IERC20Metadata(currencyToken_).decimals() != 18) revert InvalidParameters();

        _storage.currencyToken = IERC20(currencyToken_);
        _storage.admin = msg.sender;

        /* Assign durations */
        if (durations_.length > Tick.MAX_NUM_DURATIONS) revert InvalidParameters();
        for (uint256 i; i < durations_.length; i++) {
            /* Check duration is monotonic */
            if (i != 0 && durations_[i] >= durations_[i - 1]) revert InvalidParameters();
            _storage.durations.push(durations_[i]);
        }

        /* Assign rates */
        if (rates_.length > Tick.MAX_NUM_RATES) revert InvalidParameters();
        for (uint256 i; i < rates_.length; i++) {
            /* Check rate is monotonic */
            if (i != 0 && rates_[i] <= rates_[i - 1]) revert InvalidParameters();
            _storage.rates.push(rates_[i]);
        }

        /* Initialize liquidity */
        _storage.liquidity.initialize();
    }

    /**************************************************************************/
    /* Getters */
    /**************************************************************************/

    /**
     * @notice Get implementation name
     * @return Implementation name
     */
    function IMPLEMENTATION_NAME() external pure virtual returns (string memory);

    /**
     * @notice Get implementation version
     * @return Implementation version
     */
    function IMPLEMENTATION_VERSION() external pure returns (string memory) {
        return "2.3";
    }

    /**
     * @inheritdoc IPool
     */
    function currencyToken() external view returns (address) {
        return address(_storage.currencyToken);
    }

    /**
     * @inheritdoc IPool
     */
    function durations() external view returns (uint64[] memory) {
        return _storage.durations;
    }

    /**
     * @inheritdoc IPool
     */
    function rates() external view returns (uint64[] memory) {
        return _storage.rates;
    }

    /**
     * @inheritdoc IPool
     */
    function admin() external view returns (address) {
        return _storage.admin;
    }

    /**
     * @inheritdoc IPool
     */
    function adminFeeRate() external view returns (uint32) {
        return _storage.adminFeeRate;
    }

    /**
     * @inheritdoc IPool
     */
    function adminFeeBalance() external view returns (uint256) {
        return _storage.adminFeeBalance;
    }

    /**
     * @inheritdoc IPool
     */
    function collateralWrappers() external view returns (address[] memory) {
        address[] memory collateralWrappers_ = new address[](3);
        collateralWrappers_[0] = _collateralWrapper1;
        collateralWrappers_[1] = _collateralWrapper2;
        collateralWrappers_[2] = _collateralWrapper3;
        return collateralWrappers_;
    }

    /**
     * @inheritdoc IPool
     */
    function collateralLiquidator() external view returns (address) {
        return address(_collateralLiquidator);
    }

    /**
     * @inheritdoc IPool
     */
    function delegationRegistry() external view returns (address) {
        return address(_delegateRegistryV1);
    }

    /**
     * @inheritdoc IPool
     */
    function delegationRegistryV2() external view returns (address) {
        return address(_delegateRegistryV2);
    }

    /**
     * @notice Get deposit
     * @param account Account
     * @param tick Tick
     * @return shares Shares
     * @return redemptionId Redemption ID
     */
    function deposits(address account, uint128 tick) external view returns (uint128 shares, uint128 redemptionId) {
        shares = _storage.deposits[account][tick].shares;
        redemptionId = _storage.deposits[account][tick].redemptionId;
    }

    /**
     * @notice Get redemption
     * @param account Account
     * @param tick Tick
     * @param redemptionId Redemption ID
     * @return Redemption
     */
    function redemptions(
        address account,
        uint128 tick,
        uint128 redemptionId
    ) external view returns (Redemption memory) {
        return _storage.deposits[account][tick].redemptions[redemptionId];
    }

    /**
     * @notice Get loan status
     * @param receiptHash Loan receipt hash
     * @return Loan status
     */
    function loans(bytes32 receiptHash) external view returns (LoanStatus) {
        return _storage.loans[receiptHash];
    }

    /**
     * @inheritdoc ILiquidity
     */
    function liquidityNodes(uint128 startTick, uint128 endTick) external view returns (NodeInfo[] memory) {
        return _storage.liquidity.liquidityNodes(startTick, endTick);
    }

    /**
     * @inheritdoc ILiquidity
     */
    function liquidityNode(uint128 tick) external view returns (NodeInfo memory) {
        return _storage.liquidity.liquidityNode(tick);
    }

    /**
     * @inheritdoc ILiquidity
     */
    function liquidityNodeWithAccrual(uint128 tick) external view returns (NodeInfo memory, AccrualInfo memory) {
        return _storage.liquidity.liquidityNodeWithAccrual(tick);
    }

    /**
     * @inheritdoc ILiquidity
     */
    function depositSharePrice(uint128 tick) external view returns (uint256) {
        return _storage.liquidity.depositSharePrice(tick);
    }

    /**
     * @inheritdoc ILiquidity
     */
    function redemptionSharePrice(uint128 tick) external view returns (uint256) {
        return _storage.liquidity.redemptionSharePrice(tick);
    }

    /**************************************************************************/
    /* Loan Receipt External Helpers */
    /**************************************************************************/

    /**
     * @notice Decode loan receipt
     * @param loanReceipt Loan receipt
     * @return Decoded loan receipt
     */
    function decodeLoanReceipt(bytes calldata loanReceipt) external pure returns (LoanReceipt.LoanReceiptV2 memory) {
        return BorrowLogic._decodeLoanReceipt(loanReceipt);
    }

    /**************************************************************************/
    /* Helper Functions */
    /**************************************************************************/

    /**
     * @notice Helper function that returns underlying collateral in (address,
     * uint256[], uint256) shape
     * @param collateralToken Collateral token, either underlying token or collateral wrapper
     * @param collateralTokenId Collateral token ID
     * @param collateralWrapperContext Collateral wrapper context
     * @return token Underlying collateral token
     * @return tokenIds Underlying collateral token IDs (unique)
     * @return tokenCount Underlying total token count
     */
    function _getUnderlyingCollateral(
        address collateralToken,
        uint256 collateralTokenId,
        bytes memory collateralWrapperContext
    ) internal view returns (address token, uint256[] memory tokenIds, uint256 tokenCount) {
        /* Enumerate if collateral token is a collateral wrapper */
        if (
            collateralToken == _collateralWrapper1 ||
            collateralToken == _collateralWrapper2 ||
            collateralToken == _collateralWrapper3
        ) {
            (token, tokenIds) = ICollateralWrapper(collateralToken).enumerate(
                collateralTokenId,
                collateralWrapperContext
            );
            tokenCount = ICollateralWrapper(collateralToken).count(collateralTokenId, collateralWrapperContext);
            return (token, tokenIds, tokenCount);
        }

        /* If single asset, convert to length one token ID array */
        token = collateralToken;
        tokenIds = new uint256[](1);
        tokenIds[0] = collateralTokenId;
        tokenCount = 1;
    }

    /**
     * @notice Get reference to ERC-7201 delegate storage
     * @return $ Reference to delegate storage
     */
    function _getDelegateStorage() private pure returns (DelegateStorage storage $) {
        assembly {
            $.slot := DELEGATE_STORAGE_LOCATION
        }
    }

    /**
     * @dev Helper function to quote a loan
     * @param principal Principal amount in currency tokens
     * @param duration Duration in seconds
     * @param collateralToken Collateral token address
     * @param collateralTokenId Collateral token ID
     * @param ticks Liquidity node ticks
     * @param collateralWrapperContext Collateral wrapper context
     * @param collateralFilterContext Collateral filter context
     * @param isRefinance True if called by refinance()
     * @return Repayment amount in currency tokens, admin fee in currency
     * tokens, liquidity nodes, liquidity node count
     */
    function _quote(
        uint256 principal,
        uint64 duration,
        address collateralToken,
        uint256 collateralTokenId,
        uint128[] calldata ticks,
        bytes memory collateralWrapperContext,
        bytes calldata collateralFilterContext,
        bool isRefinance
    ) internal view returns (uint256, uint256, LiquidityLogic.NodeSource[] memory, uint16) {
        /* Get underlying collateral */
        (
            address underlyingCollateralToken,
            uint256[] memory underlyingCollateralTokenIds,
            uint256 underlyingCollateralTokenCount
        ) = _getUnderlyingCollateral(collateralToken, collateralTokenId, collateralWrapperContext);

        /* Verify collateral is supported */
        if (!isRefinance) {
            for (uint256 i; i < underlyingCollateralTokenIds.length; i++) {
                if (
                    !_collateralSupported(
                        underlyingCollateralToken,
                        underlyingCollateralTokenIds[i],
                        i,
                        collateralFilterContext
                    )
                ) revert UnsupportedCollateral(i);
            }
        }

        /* Cache durations */
        uint64[] memory durations_ = _storage.durations;

        /* Validate duration */
        if (duration > durations_[0]) revert UnsupportedLoanDuration();

        /* Lookup duration index */
        uint256 durationIndex = durations_.length - 1;
        for (; durationIndex > 0; durationIndex--) {
            if (duration <= durations_[durationIndex]) break;
        }

        /* Source liquidity nodes */
        (LiquidityLogic.NodeSource[] memory nodes, uint16 count) = _storage.liquidity.source(
            principal,
            ticks,
            underlyingCollateralTokenCount,
            durationIndex
        );

        /* Calculate repayment from principal, rate, and duration */
        uint256 repayment = (principal *
            (LiquidityLogic.FIXED_POINT_SCALE + (_rate(principal, _storage.rates, nodes, count) * duration))) /
            LiquidityLogic.FIXED_POINT_SCALE;

        /* Compute total fee */
        uint256 totalFee = repayment - principal;

        /* Compute admin fee */
        uint256 adminFee = (_storage.adminFeeRate * totalFee) / LiquidityLogic.BASIS_POINTS_SCALE;

        /* Distribute interest */
        _distribute(principal, totalFee - adminFee, nodes, count);

        return (repayment, adminFee, nodes, count);
    }

    /**************************************************************************/
    /* Lend API */
    /**************************************************************************/

    /**
     * @inheritdoc IPool
     */
    function quote(
        uint256 principal,
        uint64 duration,
        address collateralToken,
        uint256 collateralTokenId,
        uint128[] calldata ticks,
        bytes calldata options
    ) external view returns (uint256) {
        /* Quote repayment */
        (uint256 repayment, , , ) = _quote(
            principal,
            duration,
            collateralToken,
            collateralTokenId,
            ticks,
            BorrowLogic._getOptionsData(options, BorrowOptions.CollateralWrapperContext),
            BorrowLogic._getOptionsData(options, BorrowOptions.CollateralFilterContext),
            false
        );

        return repayment;
    }

    /**
     * @inheritdoc IPool
     */
    function borrow(
        uint256 principal,
        uint64 duration,
        address collateralToken,
        uint256 collateralTokenId,
        uint256 maxRepayment,
        uint128[] calldata ticks,
        bytes calldata options
    ) external nonReentrant returns (uint256) {
        /* Quote repayment, admin fee, and liquidity nodes */
        (uint256 repayment, uint256 adminFee, LiquidityLogic.NodeSource[] memory nodes, uint16 count) = _quote(
            principal,
            duration,
            collateralToken,
            collateralTokenId,
            ticks,
            BorrowLogic._getOptionsData(options, BorrowOptions.CollateralWrapperContext),
            BorrowLogic._getOptionsData(options, BorrowOptions.CollateralFilterContext),
            false
        );

        /* Handle borrow accounting */
        (bytes memory encodedLoanReceipt, bytes32 loanReceiptHash) = BorrowLogic._borrow(
            _storage,
            principal,
            duration,
            collateralToken,
            collateralTokenId,
            repayment,
            maxRepayment,
            adminFee,
            nodes,
            count,
            BorrowLogic._getOptionsData(options, BorrowOptions.CollateralWrapperContext)
        );

        /* Handle delegate.cash option */
        BorrowLogic._optionDelegateCash(
            _getDelegateStorage(),
            collateralToken,
            collateralTokenId,
            _delegateRegistryV1,
            _delegateRegistryV2,
            options
        );

        /* Transfer collateral from borrower to pool */
        IERC721(collateralToken).transferFrom(msg.sender, address(this), collateralTokenId);

        /* Transfer principal from pool to borrower */
        _storage.currencyToken.safeTransfer(msg.sender, principal);

        /* Emit LoanOriginated */
        emit LoanOriginated(loanReceiptHash, encodedLoanReceipt);

        return repayment;
    }

    /**
     * @inheritdoc IPool
     */
    function repay(bytes calldata encodedLoanReceipt) external nonReentrant returns (uint256) {
        /* Handle repay accounting */
        (uint256 repayment, LoanReceipt.LoanReceiptV2 memory loanReceipt, bytes32 loanReceiptHash) = BorrowLogic._repay(
            _storage,
            encodedLoanReceipt
        );

        /* Revoke delegates */
        BorrowLogic._revokeDelegates(
            _getDelegateStorage(),
            loanReceipt.collateralToken,
            loanReceipt.collateralTokenId,
            _delegateRegistryV1,
            _delegateRegistryV2
        );

        /* Transfer repayment from borrower to pool */
        _storage.currencyToken.safeTransferFrom(loanReceipt.borrower, address(this), repayment);

        /* Transfer collateral from pool to borrower */
        IERC721(loanReceipt.collateralToken).transferFrom(
            address(this),
            loanReceipt.borrower,
            loanReceipt.collateralTokenId
        );

        /* Emit Loan Repaid */
        emit LoanRepaid(loanReceiptHash, repayment);

        return repayment;
    }

    /**
     * @inheritdoc IPool
     */
    function refinance(
        bytes calldata encodedLoanReceipt,
        uint256 principal,
        uint64 duration,
        uint256 maxRepayment,
        uint128[] calldata ticks
    ) external nonReentrant returns (uint256) {
        /* Handle repay accounting */
        (uint256 repayment, LoanReceipt.LoanReceiptV2 memory loanReceipt, bytes32 loanReceiptHash) = BorrowLogic._repay(
            _storage,
            encodedLoanReceipt
        );

        /* Quote new repayment, admin fee, and liquidity nodes */
        (uint256 newRepayment, uint256 adminFee, LiquidityLogic.NodeSource[] memory nodes, uint16 count) = _quote(
            principal,
            duration,
            loanReceipt.collateralToken,
            loanReceipt.collateralTokenId,
            ticks,
            loanReceipt.collateralWrapperContext,
            encodedLoanReceipt[0:0],
            true
        );

        /* Handle borrow accounting */
        (bytes memory newEncodedLoanReceipt, bytes32 newLoanReceiptHash) = BorrowLogic._borrow(
            _storage,
            principal,
            duration,
            loanReceipt.collateralToken,
            loanReceipt.collateralTokenId,
            newRepayment,
            maxRepayment,
            adminFee,
            nodes,
            count,
            loanReceipt.collateralWrapperContext
        );

        /* Determine transfer direction */
        if (principal < repayment) {
            /* Transfer prorated repayment less principal from borrower to pool */
            _storage.currencyToken.safeTransferFrom(loanReceipt.borrower, address(this), repayment - principal);
        } else {
            /* Transfer principal less prorated repayment from pool to borrower */
            _storage.currencyToken.safeTransfer(msg.sender, principal - repayment);
        }

        /* Emit Loan Repaid */
        emit LoanRepaid(loanReceiptHash, repayment);

        /* Emit LoanOriginated */
        emit LoanOriginated(newLoanReceiptHash, newEncodedLoanReceipt);

        return newRepayment;
    }

    /**
     * @inheritdoc IPool
     */
    function liquidate(bytes calldata encodedLoanReceipt) external nonReentrant {
        /* Handle liquidate accounting */
        (LoanReceipt.LoanReceiptV2 memory loanReceipt, bytes32 loanReceiptHash) = BorrowLogic._liquidate(
            _storage,
            encodedLoanReceipt
        );

        /* Revoke delegates */
        BorrowLogic._revokeDelegates(
            _getDelegateStorage(),
            loanReceipt.collateralToken,
            loanReceipt.collateralTokenId,
            _delegateRegistryV1,
            _delegateRegistryV2
        );

        /* Approve collateral for transfer to _collateralLiquidator */
        IERC721(loanReceipt.collateralToken).approve(address(_collateralLiquidator), loanReceipt.collateralTokenId);

        /* Start liquidation with collateral liquidator */
        _collateralLiquidator.liquidate(
            address(_storage.currencyToken),
            loanReceipt.collateralToken,
            loanReceipt.collateralTokenId,
            loanReceipt.collateralWrapperContext,
            encodedLoanReceipt
        );

        /* Emit Loan Liquidated */
        emit LoanLiquidated(loanReceiptHash);
    }

    /**************************************************************************/
    /* Callbacks */
    /**************************************************************************/

    /**
     * @inheritdoc ICollateralLiquidationReceiver
     */
    function onCollateralLiquidated(bytes calldata encodedLoanReceipt, uint256 proceeds) external nonReentrant {
        /* Validate caller is collateral liquidator */
        if (msg.sender != address(_collateralLiquidator)) revert InvalidCaller();

        /* Handle collateral liquidation accounting */
        (uint256 borrowerSurplus, LoanReceipt.LoanReceiptV2 memory loanReceipt, bytes32 loanReceiptHash) = BorrowLogic
            ._onCollateralLiquidated(_storage, encodedLoanReceipt, proceeds);

        /* Transfer surplus to borrower */
        if (borrowerSurplus != 0) IERC20(_storage.currencyToken).safeTransfer(loanReceipt.borrower, borrowerSurplus);

        /* Emit Collateral Liquidated */
        emit CollateralLiquidated(loanReceiptHash, proceeds, borrowerSurplus);
    }

    /**************************************************************************/
    /* Deposit API */
    /**************************************************************************/

    /**
     * @inheritdoc IPool
     */
    function deposit(uint128 tick, uint256 amount, uint256 minShares) external nonReentrant returns (uint256) {
        /* Handle deposit accounting and compute shares */
        uint128 shares = DepositLogic._deposit(_storage, tick, amount.toUint128(), minShares.toUint128());

        /* Call token hook */
        onExternalTransfer(address(0), msg.sender, tick, shares);

        /* Transfer deposit amount */
        _storage.currencyToken.safeTransferFrom(msg.sender, address(this), amount);

        /* Emit Deposited */
        emit Deposited(msg.sender, tick, amount, shares);

        return shares;
    }

    /**
     * @inheritdoc IPool
     */
    function redeem(uint128 tick, uint256 shares) external nonReentrant returns (uint128) {
        /* Handle redeem accounting */
        uint128 redemptionId = DepositLogic._redeem(_storage, tick, shares.toUint128());

        /* Call token hook */
        onExternalTransfer(msg.sender, address(0), tick, shares);

        /* Emit Redeemed event */
        emit Redeemed(msg.sender, tick, redemptionId, shares);

        return redemptionId;
    }

    /**
     * @inheritdoc IPool
     */
    function redemptionAvailable(
        address account,
        uint128 tick,
        uint128 redemptionId
    ) external view returns (uint256 shares, uint256 amount, uint256 sharesAhead) {
        /* Handle redemption available accounting */
        return DepositLogic._redemptionAvailable(_storage, account, tick, redemptionId);
    }

    /**
     * @inheritdoc IPool
     */
    function withdraw(uint128 tick, uint128 redemptionId) external nonReentrant returns (uint256, uint256) {
        /* Handle withdraw accounting and compute both shares and amount */
        (uint128 shares, uint128 amount) = DepositLogic._withdraw(_storage, tick, redemptionId);

        /* Transfer withdrawal amount */
        if (amount != 0) _storage.currencyToken.safeTransfer(msg.sender, amount);

        /* Emit Withdrawn */
        emit Withdrawn(msg.sender, tick, redemptionId, shares, amount);

        return (shares, amount);
    }

    /**
     * @inheritdoc IPool
     */
    function rebalance(
        uint128 srcTick,
        uint128 dstTick,
        uint128 redemptionId,
        uint256 minShares
    ) external nonReentrant returns (uint256, uint256, uint256) {
        /* Handle withdraw accounting and compute both shares and amount */
        (uint128 oldShares, uint128 amount) = DepositLogic._withdraw(_storage, srcTick, redemptionId);

        /* Handle deposit accounting and compute new shares */
        uint128 newShares = DepositLogic._deposit(_storage, dstTick, amount, minShares.toUint128());

        /* Call token hook */
        onExternalTransfer(address(0), msg.sender, dstTick, newShares);

        /* Emit Withdrawn */
        emit Withdrawn(msg.sender, srcTick, redemptionId, oldShares, amount);

        /* Emit Deposited */
        emit Deposited(msg.sender, dstTick, amount, newShares);

        return (oldShares, newShares, amount);
    }

    /**
     * @notice Transfer shares between accounts by operator
     *
     * @dev Only callable by deposit token contract
     *
     * @param from From
     * @param to To
     * @param tick Tick
     * @param shares Shares
     */
    function transfer(address from, address to, uint128 tick, uint256 shares) external nonReentrant {
        /* Validate caller is deposit token created by Pool */
        if (msg.sender != depositToken(tick)) revert InvalidCaller();

        /* Handle transfer accounting */
        DepositLogic._transfer(_storage, from, to, tick, shares.toUint128());

        /* Emit Transferred */
        emit Transferred(from, to, tick, shares);
    }

    /**************************************************************************/
    /* Admin Fees API */
    /**************************************************************************/

    /**
     * @notice Set the admin fee rate
     *
     * Emits a {AdminFeeRateUpdated} event.
     *
     * @param rate Rate is the admin fee in basis points
     */
    function setAdminFeeRate(uint32 rate) external {
        if (msg.sender != _storage.admin) revert InvalidCaller();
        if (rate >= LiquidityLogic.BASIS_POINTS_SCALE) revert InvalidParameters();

        _storage.adminFeeRate = rate;

        emit AdminFeeRateUpdated(rate);
    }

    /**
     * @notice Withdraw admin fees
     *
     * Emits a {AdminFeesWithdrawn} event.
     *
     * @param recipient Recipient account
     * @param amount Amount to withdraw
     */
    function withdrawAdminFees(address recipient, uint256 amount) external nonReentrant {
        if (msg.sender != _storage.admin) revert InvalidCaller();
        if (recipient == address(0) || amount > _storage.adminFeeBalance) revert InvalidParameters();

        /* Update admin fees balance */
        _storage.adminFeeBalance -= amount;

        /* Transfer cash from Pool to recipient */
        _storage.currencyToken.safeTransfer(recipient, amount);

        emit AdminFeesWithdrawn(recipient, amount);
    }

    /******************************************************/
    /* ERC165 interface */
    /******************************************************/

    /**
     * @inheritdoc IERC165
     */
    function supportsInterface(bytes4 interfaceId) public view override returns (bool) {
        return interfaceId == type(ICollateralLiquidationReceiver).interfaceId || super.supportsInterface(interfaceId);
    }
}
