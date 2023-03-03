// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.17;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/security/Pausable.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/proxy/Clones.sol";
import "@openzeppelin/contracts/utils/introspection/ERC165.sol";
import "@openzeppelin/contracts/utils/structs/EnumerableMap.sol";
import "@openzeppelin/contracts/utils/Address.sol";
import "@openzeppelin/contracts/utils/Multicall.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import "@openzeppelin/contracts/token/ERC721/utils/ERC721Holder.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

import "./interfaces/IPool.sol";
import "./interfaces/ILiquidity.sol";
import "./LoanReceipt.sol";
import "./LiquidityManager.sol";
import "./integrations/DelegateCash/IDelegationRegistry.sol";

/**
 * @title Pool
 * @author MetaStreet Labs
 */
contract Pool is ERC165, ERC721Holder, AccessControl, Pausable, ReentrancyGuard, Multicall, IPool, ILiquidity {
    using SafeERC20 for IERC20;
    using EnumerableMap for EnumerableMap.AddressToUintMap;
    using LoanReceipt for LoanReceipt.LoanReceiptV1;
    using LiquidityManager for LiquidityManager.Liquidity;

    /**************************************************************************/
    /* Access Control Roles */
    /**************************************************************************/

    /**
     * @notice Emergency administrator role
     */
    bytes32 public constant EMERGENCY_ADMIN_ROLE = keccak256("EMERGENCY_ADMIN");

    /**************************************************************************/
    /* Constants */
    /**************************************************************************/

    /**
     * @notice Implementation version
     */
    string public constant IMPLEMENTATION_VERSION = "1.0";

    /**
     * @notice Tick spacing basis points
     */
    uint256 public constant TICK_SPACING_BASIS_POINTS = LiquidityManager.TICK_SPACING_BASIS_POINTS;

    /**
     * @notice Pool borrow options tag size in bytes
     */
    uint256 internal constant BORROW_OPTIONS_TAG_SIZE = 2;

    /**
     * @notice Pool borrow options value size in bytes
     */
    uint256 internal constant BORROW_OPTIONS_VALUE_SIZE = 32;

    /**
     * @notice Basis points
     */
    uint256 internal constant BASIS_POINTS_SCALE = 10_000;

    /**************************************************************************/
    /* Errors */
    /**************************************************************************/

    /**
     * @notice Invalid address
     */
    error InvalidAddress();

    /**
     * @notice Invalid caller
     */
    error InvalidCaller();

    /**
     * @notice Invalid shares
     */
    error InvalidShares();

    /**
     * @notice Invalid loan receipt
     */
    error InvalidLoanReceipt();

    /**
     * @notice Invalid loan status
     */
    error InvalidLoanStatus();

    /**
     * @notice Invalid borrow options encoding
     */
    error InvalidBorrowOptionsEncoding();

    /**
     * @notice Invalid borrow options
     * @param index Index of invalid borrow option
     */
    error InvalidBorrowOptions(uint256 index);

    /**
     * @notice Parameter out of bounds
     */
    error ParameterOutOfBounds();

    /**
     * @notice Unsupported collateral
     * @param index Index of unsupported asset
     */
    error UnsupportedCollateral(uint256 index);

    /**
     * @notice Unsupported loan duration
     */
    error UnsupportedLoanDuration();

    /**
     * @notice Unsupported currency token
     */
    error UnsupportedCurrencyToken();

    /**
     * @notice Unsupported platform
     */
    error UnsupportedPlatform();

    /**
     * @notice Purchase price too low
     */
    error PurchasePriceTooLow();

    /**
     * @notice Repayment too high
     */
    error RepaymentTooHigh();

    /**
     * @notice Loan expired
     */
    error LoanExpired();

    /**
     * @notice Redemption in progress
     */
    error RedemptionInProgress();

    /**
     * @notice Call failed
     */
    error CallFailed();

    /**************************************************************************/
    /* Structures */
    /**************************************************************************/

    /**
     * @notice Deposit
     * @param shares Shares
     * @param redemptionPending Redemption shares pending
     * @param redemptionIndex Redemption queue index
     * @param redemptionTarget Redemption queue target
     */
    struct Deposit {
        uint128 shares;
        uint128 redemptionPending;
        uint128 redemptionIndex;
        uint128 redemptionTarget;
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
        DelegateCash
    }

    /**************************************************************************/
    /* State */
    /**************************************************************************/

    /**
     * @notice Initialized boolean
     */
    bool private _initialized;

    /**
     * @notice Collateral token contract
     */
    IERC721 internal _collateralToken;

    /**
     * @notice Currency token contract
     */
    IERC20 internal _currencyToken;

    /**
     * @notice Maximum loan duration in seconds
     */
    uint64 internal _maxLoanDuration;

    /**
     * @notice Admin fee rate in basis points
     */
    uint256 internal _adminFeeRate;

    /**
     * @notice Total admin fee balance
     */
    uint256 internal _adminFeeBalance;

    /**
     * @notice Liquidity
     */
    LiquidityManager.Liquidity internal _liquidity;

    /**
     * @notice Mapping of account to loan limit depth to deposit
     */
    mapping(address => mapping(uint128 => Deposit)) internal _deposits;

    /**
     * @notice Mapping of loan receipt hash to loan status
     */
    mapping(bytes32 => LoanStatus) internal _loans;

    /**
     * @notice Collateral filter contract
     */
    ICollateralFilter internal _collateralFilter;

    /**
     * @notice Interest rate model contract
     */
    IInterestRateModel internal _interestRateModel;

    /**
     * @notice Collateral liquidator contract
     */
    ICollateralLiquidator internal _collateralLiquidator;

    /**
     * @notice Delegation registry contract
     */
    IDelegationRegistry internal _delegationRegistry;

    /**************************************************************************/
    /* Constructor */
    /**************************************************************************/

    /**
     * @notice Pool constructor
     */
    constructor() {
        /* Disable initialization of implementation contract */
        _initialized = true;
    }

    /**************************************************************************/
    /* Initializer */
    /**************************************************************************/

    /**
     * @notice Pool initializer
     * @param admin Admin account
     * @param collateralToken_ Collateral token contract
     * @param currencyToken_ Currency token contract
     * @param maxLoanDuration_ Maximum loan duration in seconds
     * @param delegationRegistry_ Delegation registry contract
     * @param collateralFilterImpl Collateral filter implementation contract
     * @param interestRateModelImpl Interest rate model implementation contract
     * @param collateralLiquidatorImpl Collateral liquidator implementation contract
     * @param collateralFilterParams Collateral filter initialization parameters
     * @param interestRateModelParams Interest rate model initialization parameters
     * @param collateralLiquidatorParams Collateral liquidator initialization parameters
     */
    function initialize(
        address admin,
        IERC721 collateralToken_,
        IERC20 currencyToken_,
        uint64 maxLoanDuration_,
        IDelegationRegistry delegationRegistry_,
        address collateralFilterImpl,
        address interestRateModelImpl,
        address collateralLiquidatorImpl,
        bytes memory collateralFilterParams,
        bytes memory interestRateModelParams,
        bytes memory collateralLiquidatorParams
    ) external {
        require(!_initialized, "Already initialized");

        _initialized = true;
        _collateralToken = collateralToken_;
        /* FIXME verify 18 decimals */
        _currencyToken = currencyToken_;
        _maxLoanDuration = maxLoanDuration_;
        _delegationRegistry = delegationRegistry_;

        /* Initialize liquidity */
        _liquidity.initialize();

        /* Deploy collateral filter instance */
        address collateralFilterInstance = Clones.clone(collateralFilterImpl);
        Address.functionCall(
            collateralFilterInstance,
            abi.encodeWithSignature("initialize(bytes)", collateralFilterParams)
        );
        _collateralFilter = ICollateralFilter(collateralFilterInstance);

        /* Deploy interest rate model instance */
        address interestRateModelInstance = Clones.clone(interestRateModelImpl);
        Address.functionCall(
            interestRateModelInstance,
            abi.encodeWithSignature("initialize(bytes)", interestRateModelParams)
        );
        _interestRateModel = IInterestRateModel(interestRateModelInstance);

        /* Deploy collateral liquidator instance */
        address collateralLiquidatorInstance = Clones.clone(collateralLiquidatorImpl);
        Address.functionCall(
            collateralLiquidatorInstance,
            abi.encodeWithSignature("initialize(bytes)", collateralLiquidatorParams)
        );
        _collateralLiquidator = ICollateralLiquidator(collateralLiquidatorInstance);

        /* Grant roles */
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(EMERGENCY_ADMIN_ROLE, msg.sender);
    }

    /**************************************************************************/
    /* Getters */
    /**************************************************************************/

    /**
     * @inheritdoc IPool
     */
    function collateralToken() external view returns (address) {
        return address(_collateralToken);
    }

    /**
     * @inheritdoc IPool
     */
    function currencyToken() external view returns (address) {
        return address(_currencyToken);
    }

    /**
     * @inheritdoc IPool
     */
    function maxLoanDuration() external view returns (uint64) {
        return _maxLoanDuration;
    }

    /**
     * @inheritdoc IPool
     */
    function adminFeeRate() external view returns (uint256) {
        return _adminFeeRate;
    }

    /**
     * @inheritdoc IPool
     */
    function collateralFilter() external view returns (ICollateralFilter) {
        return _collateralFilter;
    }

    /**
     * @inheritdoc IPool
     */
    function interestRateModel() external view returns (IInterestRateModel) {
        return _interestRateModel;
    }

    /**
     * @inheritdoc IPool
     */
    function collateralLiquidator() external view returns (ICollateralLiquidator) {
        return _collateralLiquidator;
    }

    /**
     * @inheritdoc IPool
     */
    function delegationRegistry() external view returns (address) {
        return address(_delegationRegistry);
    }

    /**
     * @notice Get deposit
     * @param account Account
     * @param depth Depth
     * @return Deposit information
     */
    function deposits(address account, uint256 depth) external view returns (Deposit memory) {
        return _deposits[account][uint128(depth)];
    }

    /**
     * @notice Get loan status
     * @param receiptHash Loan receipt hash
     * @return Loan status
     */
    function loans(bytes32 receiptHash) external view returns (LoanStatus) {
        return _loans[receiptHash];
    }

    /**
     * @notice Decode loan receipt
     * @param loanReceipt Loan receipt
     * @return Decoded loan receipt
     */
    function decodeLoanReceipt(bytes calldata loanReceipt) external pure returns (LoanReceipt.LoanReceiptV1 memory) {
        return LoanReceipt.decode(loanReceipt);
    }

    /**
     * @notice Get total admin fee balance
     * @return Total admin fee balance
     */
    function adminFeeBalance() external view returns (uint256) {
        return _adminFeeBalance;
    }

    /**************************************************************************/
    /* ILiquidity Getters */
    /**************************************************************************/

    /**
     * @inheritdoc ILiquidity
     */
    function utilization() public view returns (uint256) {
        return
            (_liquidity.total == 0)
                ? 0
                : Math.mulDiv(_liquidity.used, LiquidityManager.FIXED_POINT_SCALE, _liquidity.total);
    }

    /**
     * @inheritdoc ILiquidity
     */
    function liquidityStatistics() external view returns (uint256, uint256, uint16) {
        return (_liquidity.total, _liquidity.used, _liquidity.numNodes);
    }

    /**
     * @inheritdoc ILiquidity
     */
    function liquidityAvailable(uint256 maxDepth) external view returns (uint256) {
        return _liquidity.liquidityAvailable(maxDepth);
    }

    /**
     * @inheritdoc ILiquidity
     */
    function liquidityNodes(uint256 startDepth, uint256 endDepth) external view returns (NodeInfo[] memory) {
        return _liquidity.liquidityNodes(startDepth, endDepth);
    }

    /**
     * @inheritdoc ILiquidity
     */
    function liquidityNode(uint256 depth) external view returns (NodeInfo memory) {
        return _liquidity.liquidityNode(depth);
    }

    /**************************************************************************/
    /* Helper Functions */
    /**************************************************************************/

    /**
     * @dev Helper function to process borrow options
     * @param collateralToken_ Contract address of token being borrowed against
     * @param collateralTokenId Token id of token being borrowed against
     * @param options Borrow function parameter
     */
    function _processBorrowOptions(
        address collateralToken_,
        uint256 collateralTokenId,
        bytes calldata options
    ) internal {
        /* Tightly packed options format */
        /*
            options (34 bytes, repeating)
            -eg:
                -0 indexed option-
                2   uint16    tag-1     0:2
                32  bytes32   value-1   2:34

                -1 indexed option-
                2   uint16    tag-2     34:36
                32  bytes32   value-2   36:68

                ...

                -n indexed option-
                2   uint16  tag-n       34n:34n+2
                32  bytes32 value-n     34n+2:34n+34
        */

        bool delegated;
        uint256 payloadSize = BORROW_OPTIONS_TAG_SIZE + BORROW_OPTIONS_VALUE_SIZE;

        if (options.length % payloadSize != 0) revert InvalidBorrowOptionsEncoding();

        for (uint256 i = 0; i < options.length / payloadSize; i++) {
            uint256 offset = i * payloadSize;

            uint16 tag = uint16(bytes2(options[offset:offset + BORROW_OPTIONS_TAG_SIZE]));
            bytes32 value = bytes32(options[offset + BORROW_OPTIONS_TAG_SIZE:offset + payloadSize]);

            /* delegate.cash */
            if (tag == uint256(BorrowOptions.DelegateCash)) {
                if (delegated) revert InvalidBorrowOptions(i);
                delegated = true;

                address delegate = address(uint160(uint256(value)));
                _delegationRegistry.delegateForToken(delegate, collateralToken_, collateralTokenId, true);
            }
        }
    }

    /**
     * @dev Helper function to revoke token delegate
     * @param collateralToken_ Contract address of token that delegation is being removed from
     * @param collateralTokenId Token id of token that delegation is being removed from
     */
    function _revokeDelegates(address collateralToken_, uint256 collateralTokenId) internal {
        /* Get delegates for collateral token and id */
        address[] memory delegates = _delegationRegistry.getDelegatesForToken(
            address(this),
            collateralToken_,
            collateralTokenId
        );

        for (uint256 i = 0; i < delegates.length; i++) {
            /* Revoke by setting value to false */
            _delegationRegistry.delegateForToken(delegates[i], collateralToken_, collateralTokenId, false);
        }
    }

    /**************************************************************************/
    /* Lend API */
    /**************************************************************************/

    /**
     * @dev Helper function to quote a loan
     * @param principal Principal amount in currency tokens
     * @param duration Duration in seconds
     * @param collateralTokenIds Collateral token IDs
     * @return Repayment amount in currency tokens
     */
    function _quote(
        uint256 principal,
        uint64 duration,
        uint256[] calldata collateralTokenIds
    ) internal view returns (uint256) {
        /* FIXME implement bundle support */
        require(collateralTokenIds.length == 1, "Bundles not supported");

        /* Verify collateral is supported */
        if (!_collateralFilter.supported(address(_collateralToken), collateralTokenIds[0], ""))
            revert UnsupportedCollateral(0);

        /* Validate loan duration */
        if (duration > _maxLoanDuration) revert UnsupportedLoanDuration();

        /* Calculate repayment from princiapl, rate, and duration */
        return
            Math.mulDiv(
                principal,
                LiquidityManager.FIXED_POINT_SCALE + (_interestRateModel.rate() * duration),
                LiquidityManager.FIXED_POINT_SCALE
            );
    }

    /**
     * @inheritdoc IPool
     */
    function quote(
        uint256 principal,
        uint64 duration,
        uint256[] calldata collateralTokenIds,
        bytes calldata
    ) external view returns (uint256) {
        /* Check principal doesn't exceed max borrow available */
        if (principal > _liquidity.liquidityAvailable(type(uint256).max))
            revert LiquidityManager.InsufficientLiquidity();

        return _quote(principal, duration, collateralTokenIds);
    }

    /**
     * @inheritdoc IPool
     */
    function borrow(
        uint256 principal,
        uint64 duration,
        uint256[] calldata collateralTokenIds,
        uint256 maxRepayment,
        uint256[] calldata depths,
        bytes calldata options
    ) external nonReentrant returns (uint256) {
        /* Quote repayment */
        uint256 repayment = _quote(principal, duration, collateralTokenIds);

        /* Validate repayment */
        if (repayment > maxRepayment) revert RepaymentTooHigh();

        /* Source liquidity nodes */
        (ILiquidity.NodeSource[] memory nodes, uint16 count) = _liquidity.source(principal, depths);

        /* Compute admin fee */
        uint256 adminFee = Math.mulDiv(_adminFeeRate, repayment - principal, BASIS_POINTS_SCALE);

        /* Distribute interest */
        uint128[] memory interest = _interestRateModel.distribute(repayment - principal - adminFee, nodes, count);

        /* Build the loan receipt */
        LoanReceipt.LoanReceiptV1 memory receipt = LoanReceipt.LoanReceiptV1({
            version: 1,
            principal: principal,
            repayment: repayment,
            borrower: msg.sender,
            maturity: uint64(block.timestamp + duration),
            duration: duration,
            collateralToken: address(_collateralToken),
            collateralTokenId: collateralTokenIds[0],
            nodeReceipts: new LoanReceipt.NodeReceipt[](count)
        });

        /* Use liquidity nodes */
        for (uint256 i; i < count; i++) {
            /* Use node */
            _liquidity.use(nodes[i].depth, nodes[i].used, nodes[i].used + interest[i]);

            /* Construct node receipt */
            receipt.nodeReceipts[i] = LoanReceipt.NodeReceipt({
                depth: nodes[i].depth,
                used: nodes[i].used,
                pending: nodes[i].used + interest[i]
            });
        }

        /* Update top level liquidity statistics */
        _liquidity.used += uint128(principal);

        /* Update utilization tracking */
        _interestRateModel.onUtilizationUpdated(utilization());

        /* Encode and hash the loan receipt */
        bytes memory encodedLoanReceipt = receipt.encode();
        bytes32 loanReceiptHash = LoanReceipt.hash(encodedLoanReceipt);

        /* Store loan status */
        _loans[loanReceiptHash] = LoanStatus.Active;

        /* Handle borrow options parameter */
        if (options.length > 0) {
            _processBorrowOptions(address(_collateralToken), collateralTokenIds[0], options);
        }

        /* Transfer collateral from borrower to pool */
        IERC721(_collateralToken).safeTransferFrom(msg.sender, address(this), collateralTokenIds[0]);

        /* Transfer principal from pool to borrower */
        _currencyToken.safeTransfer(msg.sender, principal);

        /* Emit LoanOriginated */
        emit LoanOriginated(loanReceiptHash, encodedLoanReceipt);

        return principal;
    }

    /**
     * @inheritdoc IPool
     */
    function repay(bytes calldata encodedLoanReceipt) external nonReentrant {
        /* Compute loan receipt hash */
        bytes32 loanReceiptHash = LoanReceipt.hash(encodedLoanReceipt);

        /* Validate loan receipt */
        if (_loans[loanReceiptHash] != LoanStatus.Active) revert InvalidLoanReceipt();

        /* Decode loan receipt */
        LoanReceipt.LoanReceiptV1 memory loanReceipt = LoanReceipt.decode(encodedLoanReceipt);

        /* Validate caller is borrower */
        if (msg.sender != loanReceipt.borrower) revert InvalidCaller();

        /* Validate loan is not expired */
        if (block.timestamp > loanReceipt.maturity) revert LoanExpired();

        /* Revoke delegates */
        _revokeDelegates(loanReceipt.collateralToken, loanReceipt.collateralTokenId);

        /* Compute proration based on elapsed duration. Proration can't exceed
         * 1.0 due to the loan expiry check above. */
        uint256 proration = Math.mulDiv(
            block.timestamp - (loanReceipt.maturity - loanReceipt.duration),
            LiquidityManager.FIXED_POINT_SCALE,
            loanReceipt.duration
        );

        /* Compute repayment using prorated interest */
        uint256 repayment = loanReceipt.principal +
            Math.mulDiv(loanReceipt.repayment - loanReceipt.principal, proration, LiquidityManager.FIXED_POINT_SCALE);

        /* Transfer repayment from borrower to lender */
        _currencyToken.safeTransferFrom(loanReceipt.borrower, address(this), repayment);

        /* Transfer collateral from pool to borrower */
        IERC721(loanReceipt.collateralToken).safeTransferFrom(
            address(this),
            loanReceipt.borrower,
            loanReceipt.collateralTokenId
        );

        /* Restore liquidity nodes */
        uint128 totalPending;
        uint128 totalUsed;
        for (uint256 i; i < loanReceipt.nodeReceipts.length; i++) {
            /* Restore node */
            _liquidity.restore(
                loanReceipt.nodeReceipts[i].depth,
                loanReceipt.nodeReceipts[i].used,
                loanReceipt.nodeReceipts[i].pending,
                loanReceipt.nodeReceipts[i].used +
                    uint128(
                        Math.mulDiv(
                            loanReceipt.nodeReceipts[i].pending - loanReceipt.nodeReceipts[i].used,
                            proration,
                            LiquidityManager.FIXED_POINT_SCALE
                        )
                    )
            );

            /* Track totals */
            totalPending += loanReceipt.nodeReceipts[i].pending;
            totalUsed += loanReceipt.nodeReceipts[i].used;
        }

        /* Update top level liquidity statistics with prorated interest earned by pool */
        _liquidity.total += uint128(
            Math.mulDiv(totalPending - totalUsed, proration, LiquidityManager.FIXED_POINT_SCALE)
        );
        _liquidity.used -= totalUsed;

        /* Update admin fee total balance with prorated admin fee */
        _adminFeeBalance += Math.mulDiv(
            loanReceipt.repayment - totalPending,
            proration,
            LiquidityManager.FIXED_POINT_SCALE
        );

        /* Update utilization tracking */
        _interestRateModel.onUtilizationUpdated(utilization());

        /* Mark loan status repaid */
        _loans[loanReceiptHash] = LoanStatus.Repaid;

        /* Emit Loan Repaid */
        emit LoanRepaid(loanReceiptHash, repayment);
    }

    /**
     * @inheritdoc IPool
     */
    function liquidate(bytes calldata encodedLoanReceipt) external nonReentrant {
        /* Compute loan receipt hash */
        bytes32 loanReceiptHash = LoanReceipt.hash(encodedLoanReceipt);

        /* Validate loan status is active */
        if (_loans[loanReceiptHash] != LoanStatus.Active) revert InvalidLoanReceipt();

        /* Decode loan receipt */
        LoanReceipt.LoanReceiptV1 memory loanReceipt = LoanReceipt.decode(encodedLoanReceipt);

        /* Validate loan is expired */
        if (block.timestamp < loanReceipt.maturity) revert InvalidLoanStatus();

        /* Transfer collateral to _collateralLiquidator */
        IERC721(loanReceipt.collateralToken).safeTransferFrom(
            address(this),
            address(_collateralLiquidator),
            loanReceipt.collateralTokenId,
            encodedLoanReceipt
        );

        /* Mark loan status liquidated */
        _loans[loanReceiptHash] = LoanStatus.Liquidated;

        /* Revoke delegates */
        _revokeDelegates(loanReceipt.collateralToken, loanReceipt.collateralTokenId);

        /* Emit Loan Liquidated */
        emit LoanLiquidated(loanReceiptHash);
    }

    /**************************************************************************/
    /* Callbacks */
    /**************************************************************************/

    /**
     * @inheritdoc IPool
     */
    function onCollateralLiquidated(bytes calldata encodedLoanReceipt, uint256 proceeds) external nonReentrant {
        /* Validate caller is collateral liquidator */
        if (msg.sender != address(_collateralLiquidator)) revert InvalidCaller();

        /* Compute loan receipt hash */
        bytes32 loanReceiptHash = LoanReceipt.hash(encodedLoanReceipt);

        /* Validate loan status is active */
        if (_loans[loanReceiptHash] != LoanStatus.Liquidated) revert InvalidLoanReceipt();

        /* Decode loan receipt */
        LoanReceipt.LoanReceiptV1 memory loanReceipt = LoanReceipt.decode(encodedLoanReceipt);

        /* Restore liquidity nodes */
        uint128 totalUsed;
        uint128 proceedsRemaining = uint128(proceeds);
        for (uint256 i; i < loanReceipt.nodeReceipts.length; i++) {
            /* Restore node */
            uint128 restored = (i == loanReceipt.nodeReceipts.length - 1)
                ? proceedsRemaining
                : uint128(Math.min(loanReceipt.nodeReceipts[i].pending, proceedsRemaining));
            _liquidity.restore(
                loanReceipt.nodeReceipts[i].depth,
                loanReceipt.nodeReceipts[i].used,
                loanReceipt.nodeReceipts[i].pending,
                restored
            );

            /* Track totals */
            proceedsRemaining -= restored;
            totalUsed += loanReceipt.nodeReceipts[i].used;
        }

        /* Update top level liquidity statistics */
        _liquidity.total = (uint128(proceeds) > totalUsed)
            ? (_liquidity.total + uint128(proceeds) - totalUsed)
            : (_liquidity.total - totalUsed + uint128(proceeds));
        _liquidity.used -= totalUsed;

        /* Update utilization tracking */
        _interestRateModel.onUtilizationUpdated(utilization());

        /* Mark loan status collateral liquidated */
        _loans[loanReceiptHash] = LoanStatus.CollateralLiquidated;

        /* Transfer proceeds from liquidator to pool */
        _currencyToken.safeTransferFrom(address(_collateralLiquidator), address(this), proceeds);

        /* Emit Collateral Liquidated */
        emit CollateralLiquidated(loanReceiptHash, proceeds);
    }

    /**************************************************************************/
    /* Deposit API */
    /**************************************************************************/

    /**
     * @inheritdoc IPool
     */
    function deposit(uint256 depth, uint256 amount) external nonReentrant {
        /* Instantiate liquidity node */
        _liquidity.instantiate(uint128(depth));

        /* Deposit into liquidity node */
        uint128 shares = _liquidity.deposit(uint128(depth), uint128(amount));

        /* Add to deposit */
        _deposits[msg.sender][uint128(depth)].shares += shares;

        /* Update utilization tracking */
        _interestRateModel.onUtilizationUpdated(utilization());

        /* Process redemptions from available cash */
        _liquidity.processRedemptions(uint128(depth));

        /* Transfer Deposit Amount */
        _currencyToken.safeTransferFrom(msg.sender, address(this), amount);

        /* Emit Deposited */
        emit Deposited(msg.sender, depth, amount, shares);
    }

    /**
     * @inheritdoc IPool
     */
    function redeem(uint256 depth, uint256 shares) external nonReentrant {
        /* Look up Deposit */
        Deposit storage dep = _deposits[msg.sender][uint128(depth)];

        /* Validate shares */
        if (shares > dep.shares) revert InvalidShares();
        /* Validate redemption isn't pending */
        if (dep.redemptionPending != 0) revert RedemptionInProgress();

        /* Redeem shares in tick with liquidity manager */
        (uint128 redemptionIndex, uint128 redemptionTarget) = _liquidity.redeem(uint128(depth), uint128(shares));

        /* Update deposit state */
        dep.redemptionPending = uint128(shares);
        dep.redemptionIndex = redemptionIndex;
        dep.redemptionTarget = redemptionTarget;

        /* Process redemptions from available cash */
        _liquidity.processRedemptions(uint128(depth));

        /* Update utilization tracking */
        _interestRateModel.onUtilizationUpdated(utilization());

        /* Emit Redeemed event */
        emit Redeemed(msg.sender, depth, shares);
    }

    /**
     * @inheritdoc IPool
     */
    function redemptionAvailable(
        address account,
        uint256 depth
    ) external view returns (uint256 shares, uint256 amount) {
        /* Look up Deposit */
        Deposit storage dep = _deposits[account][uint128(depth)];

        /* If no redemption is pending */
        if (dep.redemptionPending == 0) return (0, 0);

        return
            _liquidity.redemptionAvailable(
                uint128(depth),
                dep.redemptionPending,
                dep.redemptionIndex,
                dep.redemptionTarget
            );
    }

    /**
     * @inheritdoc IPool
     */
    function withdraw(uint256 depth) external nonReentrant returns (uint256) {
        /* Look up Deposit */
        Deposit storage dep = _deposits[msg.sender][uint128(depth)];

        /* If no redemption is pending */
        if (dep.redemptionPending == 0) return 0;

        /* Look up redemption available */
        (uint128 shares, uint128 amount) = _liquidity.redemptionAvailable(
            uint128(depth),
            dep.redemptionPending,
            dep.redemptionIndex,
            dep.redemptionTarget
        );

        /* If the entire redemption is ready */
        if (shares == dep.redemptionPending) {
            dep.shares -= shares;
            dep.redemptionPending = 0;
            dep.redemptionIndex = 0;
            dep.redemptionTarget = 0;
        } else {
            dep.shares -= shares;
            dep.redemptionPending -= shares;
            dep.redemptionTarget += shares;
        }

        /* Transfer Withdrawal Amount */
        _currencyToken.safeTransfer(msg.sender, amount);

        /* Emit Withdrawn */
        emit Withdrawn(msg.sender, uint128(depth), shares, amount);

        return amount;
    }

    /**************************************************************************/
    /* Admin API */
    /**************************************************************************/

    /**
     * @notice Pause contract
     */
    function pause() external onlyRole(EMERGENCY_ADMIN_ROLE) {
        _pause();
    }

    /**
     * @notice Unpause contract
     */
    function unpause() external onlyRole(EMERGENCY_ADMIN_ROLE) {
        _unpause();
    }

    /**
     * @notice Set the admin fee rate
     *
     * Emits a {AdminFeeRateUpdated} event.
     *
     * @param rate Rate is the admin fee in basis points
     */
    function setAdminFeeRate(uint256 rate) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (rate == 0 || rate >= BASIS_POINTS_SCALE) revert ParameterOutOfBounds();
        _adminFeeRate = rate;
        emit AdminFeeRateUpdated(rate);
    }

    /**************************************************************************/
    /* Admin Fees API */
    /**************************************************************************/

    /**
     * @notice Withdraw admin fees
     *
     * Emits a {AdminFeesWithdrawn} event.
     *
     * @param recipient Recipient account
     * @param amount Amount to withdraw
     */
    function withdrawAdminFees(address recipient, uint256 amount) external nonReentrant onlyRole(DEFAULT_ADMIN_ROLE) {
        if (recipient == address(0)) revert InvalidAddress();
        if (amount > _adminFeeBalance) revert ParameterOutOfBounds();

        /* Update admin fees balance */
        _adminFeeBalance -= amount;

        /* Transfer cash from vault to recipient */
        _currencyToken.safeTransfer(recipient, amount);

        emit AdminFeesWithdrawn(recipient, amount);
    }

    /******************************************************/
    /* ERC165 interface */
    /******************************************************/

    /**
     * @inheritdoc IERC165
     */
    function supportsInterface(bytes4 interfaceId) public view override(AccessControl, ERC165) returns (bool) {
        return interfaceId == type(IERC721Receiver).interfaceId || super.supportsInterface(interfaceId);
    }
}
