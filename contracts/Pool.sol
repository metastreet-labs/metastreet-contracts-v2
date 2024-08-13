// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.25;

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
import "./oracle/PriceOracle.sol";

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
    PriceOracle,
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
     * @notice Tick spacing basis points for absolute type
     */
    uint256 public constant ABSOLUTE_TICK_LIMIT_SPACING_BASIS_POINTS =
        LiquidityLogic.ABSOLUTE_TICK_LIMIT_SPACING_BASIS_POINTS;

    /**
     * @notice Tick spacing basis points for ratio type
     */
    uint256 public constant RATIO_TICK_LIMIT_SPACING_BASIS_POINTS =
        LiquidityLogic.RATIO_TICK_LIMIT_SPACING_BASIS_POINTS;

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
     * @param delegates Mapping of collateralToken to token ID to Delegate
     */
    struct DelegateStorage {
        mapping(address => mapping(uint256 => Delegate)) delegates;
    }

    /**
     * @custom:storage-location pool.feeShareStorage
     * @param recipient Fee share recipient
     * @param split Fee share split of admin fee in basis points
     */
    struct FeeShareStorage {
        address recipient;
        uint16 split;
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
        DelegateCashV2,
        OracleContext
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
     * @dev Erroneous inclusion of "erc7201" in the above namespace ID. No intention to fix.
     */
    bytes32 internal constant DELEGATE_STORAGE_LOCATION =
        0xf0e5094ebd597f2042580340ce53d1b15e5b64e0d8be717ecde51dd37c619300;

    /**
     * @notice Fee share storage slot
     * @dev keccak256(abi.encode(uint256(keccak256("pool.feeShareStorage")) - 1)) & ~bytes32(uint256(0xff));
     */
    bytes32 internal constant FEE_SHARE_STORAGE_LOCATION =
        0x1004a5c92d0898c7512a97f012b3e1b4d5140998c1fd26690d21ba53eace8b00;

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
        if (IERC20Metadata(currencyToken_).decimals() > 18) revert InvalidParameters();

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
        return "2.13";
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
        return _unscale(_storage.adminFeeBalance, false);
    }

    /**
     * @notice Get fee share
     * @return recipient Fee share recipient
     * @return split Fee share split of admin fee in basis points
     */
    function feeShare() external view returns (address recipient, uint16 split) {
        return (_getFeeShareStorage().recipient, _getFeeShareStorage().split);
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
        return _unscale(_storage.liquidity.depositSharePrice(tick), false);
    }

    /**
     * @inheritdoc ILiquidity
     */
    function redemptionSharePrice(uint128 tick) external view returns (uint256) {
        return _unscale(_storage.liquidity.redemptionSharePrice(tick), false);
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
     * @return tokenIdQuantities Underlying collateral token ID quantities
     * @return tokenCount Underlying total token count
     */
    function _getUnderlyingCollateral(
        address collateralToken,
        uint256 collateralTokenId,
        bytes memory collateralWrapperContext
    )
        internal
        view
        returns (address token, uint256[] memory tokenIds, uint256[] memory tokenIdQuantities, uint256 tokenCount)
    {
        /* Enumerate if collateral token is a collateral wrapper */
        if (
            collateralToken == _collateralWrapper1 ||
            collateralToken == _collateralWrapper2 ||
            collateralToken == _collateralWrapper3
        ) {
            (token, tokenIds, tokenIdQuantities) = ICollateralWrapper(collateralToken).enumerateWithQuantities(
                collateralTokenId,
                collateralWrapperContext
            );
            tokenCount = ICollateralWrapper(collateralToken).count(collateralTokenId, collateralWrapperContext);
            return (token, tokenIds, tokenIdQuantities, tokenCount);
        }

        /* If single asset, convert to length one token ID array */
        token = collateralToken;
        tokenIds = new uint256[](1);
        tokenIds[0] = collateralTokenId;
        tokenIdQuantities = new uint256[](1);
        tokenIdQuantities[0] = 1;
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
     * @notice Get reference to ERC-7201 fee share storage
     * @return $ Reference to fee share storage
     */
    function _getFeeShareStorage() private pure returns (FeeShareStorage storage $) {
        assembly {
            $.slot := FEE_SHARE_STORAGE_LOCATION
        }
    }

    /**
     * @dev Helper function to quote a loan
     * @param principal Principal amount in currency tokens
     * @param duration Duration in seconds
     * @param collateralToken_ Collateral token address
     * @param collateralTokenId Collateral token ID
     * @param ticks Liquidity node ticks
     * @param collateralWrapperContext Collateral wrapper context
     * @param collateralFilterContext Collateral filter context
     * @param oracleContext Oracle context
     * @param isRefinance True if called by refinance()
     * @return Repayment amount in currency tokens, admin fee in currency
     * tokens, liquidity nodes, liquidity node count
     */
    function _quote(
        uint256 principal,
        uint64 duration,
        address collateralToken_,
        uint256 collateralTokenId,
        uint128[] calldata ticks,
        bytes memory collateralWrapperContext,
        bytes calldata collateralFilterContext,
        bytes calldata oracleContext,
        bool isRefinance
    ) internal view returns (uint256, uint256, LiquidityLogic.NodeSource[] memory, uint16) {
        /* Get underlying collateral */
        (
            address underlyingCollateralToken,
            uint256[] memory underlyingCollateralTokenIds,
            uint256[] memory underlyingQuantities,
            uint256 underlyingCollateralTokenCount
        ) = _getUnderlyingCollateral(collateralToken_, collateralTokenId, collateralWrapperContext);

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

        /* Get oracle price if price oracle exists, else 0 */
        uint256 oraclePrice = price(
            collateralToken(),
            address(_storage.currencyToken),
            underlyingCollateralTokenIds,
            underlyingQuantities,
            oracleContext
        );

        /* Source liquidity nodes */
        (LiquidityLogic.NodeSource[] memory nodes, uint16 count) = _storage.liquidity.source(
            principal,
            ticks,
            underlyingCollateralTokenCount,
            durationIndex,
            _scale(oraclePrice)
        );

        /* Price interest for liquidity nodes */
        (uint256 repayment, uint256 adminFee) = _price(
            principal,
            duration,
            nodes,
            count,
            _storage.rates,
            _storage.adminFeeRate
        );

        return (repayment, adminFee, nodes, count);
    }

    /**
     * @dev Helper function to get currency token scaling factor
     * @return Factor
     */
    function _scaleFactor() internal view returns (uint256) {
        return 10 ** (18 - IERC20Metadata(address(_storage.currencyToken)).decimals());
    }

    /**
     * @dev Helper function to scale up a value
     * @param value Value
     * @return Scaled value
     */
    function _scale(uint256 value) internal view returns (uint256) {
        return value * _scaleFactor();
    }

    /**
     * @dev Helper function to scale down a value
     * @param value Value
     * @param isRoundUp Round up if true
     * @return Unscaled value
     */
    function _unscale(uint256 value, bool isRoundUp) internal view returns (uint256) {
        uint256 factor = _scaleFactor();

        return (value % factor == 0 || !isRoundUp) ? value / factor : value / factor + 1;
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
            _scale(principal),
            duration,
            collateralToken,
            collateralTokenId,
            ticks,
            BorrowLogic._getOptionsData(options, BorrowOptions.CollateralWrapperContext),
            BorrowLogic._getOptionsData(options, BorrowOptions.CollateralFilterContext),
            BorrowLogic._getOptionsData(options, BorrowOptions.OracleContext),
            false
        );

        return _unscale(repayment, true);
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
        uint256 scaledPrincipal = _scale(principal);

        /* Quote repayment, admin fee, and liquidity nodes */
        (uint256 repayment, uint256 adminFee, LiquidityLogic.NodeSource[] memory nodes, uint16 count) = _quote(
            scaledPrincipal,
            duration,
            collateralToken,
            collateralTokenId,
            ticks,
            BorrowLogic._getOptionsData(options, BorrowOptions.CollateralWrapperContext),
            BorrowLogic._getOptionsData(options, BorrowOptions.CollateralFilterContext),
            BorrowLogic._getOptionsData(options, BorrowOptions.OracleContext),
            false
        );

        /* Handle borrow accounting */
        (bytes memory encodedLoanReceipt, bytes32 loanReceiptHash) = BorrowLogic._borrow(
            _storage,
            scaledPrincipal,
            duration,
            collateralToken,
            collateralTokenId,
            repayment,
            _scale(maxRepayment),
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

        return _unscale(repayment, true);
    }

    /**
     * @inheritdoc IPool
     */
    function repay(bytes calldata encodedLoanReceipt) external nonReentrant returns (uint256) {
        /* Get fee share storage */
        FeeShareStorage storage feeShareStorage = _getFeeShareStorage();

        /* Handle repay accounting */
        (
            uint256 repayment,
            uint256 feeShareAmount,
            LoanReceipt.LoanReceiptV2 memory loanReceipt,
            bytes32 loanReceiptHash
        ) = BorrowLogic._repay(_storage, feeShareStorage, encodedLoanReceipt);
        uint256 unscaledRepayment = _unscale(repayment, true);

        /* Revoke delegates */
        BorrowLogic._revokeDelegates(
            _getDelegateStorage(),
            loanReceipt.collateralToken,
            loanReceipt.collateralTokenId,
            _delegateRegistryV1,
            _delegateRegistryV2
        );

        /* Transfer repayment from borrower to pool */
        _storage.currencyToken.safeTransferFrom(loanReceipt.borrower, address(this), unscaledRepayment);

        /* Transfer collateral from pool to borrower */
        IERC721(loanReceipt.collateralToken).transferFrom(
            address(this),
            loanReceipt.borrower,
            loanReceipt.collateralTokenId
        );

        /* Transfer currency token to fee share recipient */
        if (feeShareAmount != 0) {
            uint256 unscaledFeeShareAmount = _unscale(feeShareAmount, false);

            _storage.currencyToken.safeTransfer(feeShareStorage.recipient, unscaledFeeShareAmount);

            /* Emit Admin Fee Share Transferred */
            emit AdminFeeShareTransferred(feeShareStorage.recipient, unscaledFeeShareAmount);
        }

        /* Emit Loan Repaid */
        emit LoanRepaid(loanReceiptHash, unscaledRepayment);

        return unscaledRepayment;
    }

    /**
     * @inheritdoc IPool
     */
    function refinance(
        bytes calldata encodedLoanReceipt,
        uint256 principal,
        uint64 duration,
        uint256 maxRepayment,
        uint128[] calldata ticks,
        bytes calldata options
    ) external nonReentrant returns (uint256) {
        uint256 scaledPrincipal = _scale(principal);

        /* Get fee share storage */
        FeeShareStorage storage feeShareStorage = _getFeeShareStorage();

        /* Handle repay accounting */
        (
            uint256 repayment,
            uint256 feeShareAmount,
            LoanReceipt.LoanReceiptV2 memory loanReceipt,
            bytes32 loanReceiptHash
        ) = BorrowLogic._repay(_storage, feeShareStorage, encodedLoanReceipt);
        uint256 unscaledRepayment = _unscale(repayment, true);

        /* Quote new repayment, admin fee, and liquidity nodes */
        (uint256 newRepayment, uint256 adminFee, LiquidityLogic.NodeSource[] memory nodes, uint16 count) = _quote(
            scaledPrincipal,
            duration,
            loanReceipt.collateralToken,
            loanReceipt.collateralTokenId,
            ticks,
            loanReceipt.collateralWrapperContext,
            encodedLoanReceipt[0:0],
            BorrowLogic._getOptionsData(options, BorrowOptions.OracleContext),
            true
        );

        /* Handle borrow accounting */
        (bytes memory newEncodedLoanReceipt, bytes32 newLoanReceiptHash) = BorrowLogic._borrow(
            _storage,
            scaledPrincipal,
            duration,
            loanReceipt.collateralToken,
            loanReceipt.collateralTokenId,
            newRepayment,
            _scale(maxRepayment),
            adminFee,
            nodes,
            count,
            loanReceipt.collateralWrapperContext
        );

        /* Determine transfer direction */
        if (principal < unscaledRepayment) {
            /* Transfer prorated repayment less principal from borrower to pool */
            _storage.currencyToken.safeTransferFrom(loanReceipt.borrower, address(this), unscaledRepayment - principal);
        } else {
            /* Transfer principal less prorated repayment from pool to borrower */
            _storage.currencyToken.safeTransfer(msg.sender, principal - unscaledRepayment);
        }

        /* Transfer currency token to fee share recipient */
        if (feeShareAmount != 0) {
            uint256 unscaledFeeShareAmount = _unscale(feeShareAmount, false);

            _storage.currencyToken.safeTransfer(feeShareStorage.recipient, unscaledFeeShareAmount);

            /* Emit Admin Fee Share Transferred */
            emit AdminFeeShareTransferred(feeShareStorage.recipient, unscaledFeeShareAmount);
        }

        /* Emit Loan Repaid */
        emit LoanRepaid(loanReceiptHash, unscaledRepayment);

        /* Emit LoanOriginated */
        emit LoanOriginated(newLoanReceiptHash, newEncodedLoanReceipt);

        return _unscale(newRepayment, true);
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
            ._onCollateralLiquidated(_storage, encodedLoanReceipt, _scale(proceeds));
        uint256 unscaledBorrowerSurplus = _unscale(borrowerSurplus, false);

        /* Transfer surplus to borrower */
        if (unscaledBorrowerSurplus != 0)
            IERC20(_storage.currencyToken).safeTransfer(loanReceipt.borrower, unscaledBorrowerSurplus);

        /* Emit Collateral Liquidated */
        emit CollateralLiquidated(loanReceiptHash, proceeds, unscaledBorrowerSurplus);
    }

    /**************************************************************************/
    /* Deposit API */
    /**************************************************************************/

    /**
     * @inheritdoc IPool
     */
    function deposit(uint128 tick, uint256 amount, uint256 minShares) external nonReentrant returns (uint256) {
        /* Handle deposit accounting and compute shares */
        uint128 shares = DepositLogic._deposit(_storage, tick, _scale(amount).toUint128(), minShares.toUint128());

        /* Call token hook */
        _onExternalTransfer(address(0), msg.sender, tick, shares);

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
        _onExternalTransfer(msg.sender, address(0), tick, shares);

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
    ) external view returns (uint256, uint256, uint256) {
        /* Handle redemption available accounting */
        (uint256 shares, uint256 amount, uint256 sharesAhead) = DepositLogic._redemptionAvailable(
            _storage,
            account,
            tick,
            redemptionId
        );

        return (shares, _unscale(amount, false), sharesAhead);
    }

    /**
     * @inheritdoc IPool
     */
    function withdraw(uint128 tick, uint128 redemptionId) external nonReentrant returns (uint256, uint256) {
        /* Handle withdraw accounting and compute both shares and amount */
        (uint128 shares, uint128 amount) = DepositLogic._withdraw(_storage, tick, redemptionId);
        uint256 unscaledAmount = _unscale(amount, false);

        /* Transfer withdrawal amount */
        if (unscaledAmount != 0) _storage.currencyToken.safeTransfer(msg.sender, unscaledAmount);

        /* Emit Withdrawn */
        emit Withdrawn(msg.sender, tick, redemptionId, shares, unscaledAmount);

        return (shares, unscaledAmount);
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

        uint256 unscaledAmount = _unscale(amount, false);

        /* Call token hook */
        _onExternalTransfer(address(0), msg.sender, dstTick, newShares);

        /* Emit Withdrawn */
        emit Withdrawn(msg.sender, srcTick, redemptionId, oldShares, unscaledAmount);

        /* Emit Deposited */
        emit Deposited(msg.sender, dstTick, unscaledAmount, newShares);

        return (oldShares, newShares, unscaledAmount);
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

    /**
     * @notice Tokenize a tick
     *
     * @param tick Tick
     * @return Deposit token address
     */
    function tokenize(uint128 tick) external returns (address) {
        /* Validate tick */
        Tick.validate(tick, 0, 0, _storage.durations.length - 1, 0, _storage.rates.length - 1);

        return _tokenize(tick);
    }

    /**************************************************************************/
    /* Admin Fees API */
    /**************************************************************************/

    /**
     * @notice Set admin fee
     *
     * Emits a {AdminFeeUpdated} event.
     *
     * @param rate Admin fee rate in basis points
     * @param feeShareRecipient Recipient of fee share
     * @param feeShareSplit Fee share split in basis points
     */
    function setAdminFee(uint32 rate, address feeShareRecipient, uint16 feeShareSplit) external {
        BorrowLogic._setAdminFee(_storage, _getFeeShareStorage(), rate, feeShareRecipient, feeShareSplit);

        emit AdminFeeUpdated(rate, feeShareRecipient, feeShareSplit);
    }

    /**
     * @notice Withdraw admin fees
     *
     * Emits a {AdminFeesWithdrawn} event.
     *
     * @param recipient Recipient account
     */
    function withdrawAdminFees(address recipient) external nonReentrant {
        uint256 amount = _unscale(BorrowLogic._withdrawAdminFees(_storage, recipient), false);

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
