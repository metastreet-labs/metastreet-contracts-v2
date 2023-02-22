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
     * @notice Pool borrow options tag size in bytes
     */
    uint256 internal constant BORROW_OPTIONS_TAG_SIZE = 2;

    /**
     * @notice Pool borrow options value size in bytes
     */
    uint256 internal constant BORROW_OPTIONS_VALUE_SIZE = 32;

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
        RepaidPending,
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
     * @notice Currency token contract
     */
    IERC20 internal _currencyToken;

    /**
     * @notice Maximum loan duration in seconds
     */
    uint64 internal _maxLoanDuration;

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

    /**
     * @notice Set of supported loan adapters
     */
    EnumerableMap.AddressToUintMap internal _loanAdapters;

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
     * @param currencyToken_ Currency token contract
     * @param maxLoanDuration_ Maximum loan duration in seconds
     * @param collateralFilterImpl Collateral filter implementation contract
     * @param interestRateModelImpl Interest rate model implementation contract
     * @param collateralLiquidator_ Collateral liquidator contract
     * @param delegationRegistry_ Delegation registry contract
     * @param collateralFilterParams Collateral filter initialization parameters
     * @param interestRateModelParams Interest rate model initialization parameters
     */
    function initialize(
        address admin,
        IERC20 currencyToken_,
        uint64 maxLoanDuration_,
        address collateralFilterImpl,
        address interestRateModelImpl,
        ICollateralLiquidator collateralLiquidator_,
        IDelegationRegistry delegationRegistry_,
        bytes memory collateralFilterParams,
        bytes memory interestRateModelParams
    ) external {
        require(!_initialized, "Already initialized");

        _initialized = true;
        /* FIXME verify 18 decimals */
        _currencyToken = currencyToken_;
        _maxLoanDuration = maxLoanDuration_;
        _collateralLiquidator = collateralLiquidator_;
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
    function delegationRegistry() external view returns (IDelegationRegistry) {
        return _delegationRegistry;
    }

    /**
     * @inheritdoc IPool
     */
    function loanAdapters(address platform) external view returns (ILoanAdapter) {
        bytes32 value = _loanAdapters._inner._values[bytes32(uint256(uint160(platform)))];
        return ILoanAdapter(address(uint160(uint256(value))));
    }

    /**
     * @inheritdoc IPool
     */
    function supportedPlatforms() external view returns (address[] memory) {
        address[] memory platforms = new address[](_loanAdapters.length());
        for (uint256 i; i < platforms.length; i++) {
            (platforms[i], ) = _loanAdapters.at(i);
        }
        return platforms;
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
     * @dev Helper function to safely get a note adapter
     * @param noteToken Note token
     * @return Note adapter
     */
    function _getNoteAdapter(address noteToken) internal view returns (INoteAdapter) {
        ILoanAdapter loanAdapter = this.loanAdapters(noteToken);
        if (address(loanAdapter) == address(0) || loanAdapter.getAdapterType() != ILoanAdapter.AdapterType.Note)
            revert UnsupportedPlatform();
        return INoteAdapter(address(loanAdapter));
    }

    /**
     * @dev Helper function to safely get a lend adapter
     * @param lendPlatform Lend platform
     * @return Lend adapter
     */
    function _getLendAdapter(address lendPlatform) internal view returns (ILendAdapter) {
        ILoanAdapter loanAdapter = this.loanAdapters(lendPlatform);
        if (address(loanAdapter) == address(0) || loanAdapter.getAdapterType() != ILoanAdapter.AdapterType.Lend)
            revert UnsupportedPlatform();
        return ILendAdapter(address(loanAdapter));
    }

    /**
     * @dev Helper function to process borrow options
     * @param collateralToken Contract address of token being borrowed against
     * @param collateralTokenId Token id of token being borrowed against
     * @param options Borrow function parameter
     */
    function _processBorrowOptions(
        address collateralToken,
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
                _delegationRegistry.delegateForToken(delegate, collateralToken, collateralTokenId, true);
            }
        }
    }

    /**
     * @dev Helper function to revoke token delegate
     * @param collateralToken Contract address of token that delegation is being removed from
     * @param collateralTokenId Token id of token that delegation is being removed from
     */
    function _revokeDelegates(address collateralToken, uint256 collateralTokenId) internal {
        /* get delegates for collateral token and id */
        address[] memory delegates = _delegationRegistry.getDelegatesForToken(
            address(this),
            collateralToken,
            collateralTokenId
        );

        for (uint256 i = 0; i < delegates.length; i++) {
            /* revoke by setting value to false */
            _delegationRegistry.delegateForToken(delegates[i], collateralToken, collateralTokenId, false);
        }
    }

    /**************************************************************************/
    /* Note API */
    /**************************************************************************/

    /**
     * @dev Helper function to price a note
     * @param principal Principal
     * @param repayment Repayment
     * @param maturity Maturity
     * @param assets Collateral assets
     * @param collateralTokenIdSpec Collateral token ID specification
     * @return Purchase price in currency tokens
     */
    function _priceNote(
        uint256 principal,
        uint256 repayment,
        uint64 maturity,
        ILoanAdapter.AssetInfo[] memory assets,
        bytes[] calldata collateralTokenIdSpec
    ) internal view returns (uint256) {
        /* FIXME implement bundle support */
        require(assets.length == 1, "Bundles not yet supported");

        /* Verify collateral is supported */
        if (!_collateralFilter.supported(assets[0].token, assets[0].tokenId, "")) revert UnsupportedCollateral(0);

        /* Calculate purchase price from repayment, rate, and remaining duration */
        return
            Math.mulDiv(
                repayment,
                LiquidityManager.FIXED_POINT_SCALE,
                LiquidityManager.FIXED_POINT_SCALE +
                    Math.mulDiv(
                        _interestRateModel.rate(),
                        (maturity - uint64(block.timestamp)) * LiquidityManager.FIXED_POINT_SCALE,
                        LiquidityManager.FIXED_POINT_SCALE
                    )
            );
    }

    /**
     * @inheritdoc IPool
     */
    function priceNote(
        address noteToken,
        uint256 noteTokenId,
        bytes[] calldata collateralTokenIdSpec
    ) external view returns (uint256) {
        /* Get note adapter */
        INoteAdapter noteAdapter = _getNoteAdapter(noteToken);

        /* Get loan ID */
        uint256 loanId = noteAdapter.getLoanId(noteTokenId);

        /* Get loan info */
        ILoanAdapter.LoanInfo memory loanInfo = noteAdapter.getLoanInfo(loanId, "");

        /* Validate loan status */
        if (noteAdapter.getLoanStatus(loanId, "") != ILoanAdapter.LoanStatus.Active) revert InvalidLoanStatus();

        /* Validate currency token */
        if (loanInfo.currencyToken != address(_currencyToken)) revert UnsupportedCurrencyToken();

        /* Validate loan duration */
        if (loanInfo.duration > _maxLoanDuration) revert UnsupportedLoanDuration();

        /* Price the note */
        return
            _priceNote(
                loanInfo.principal,
                loanInfo.repayment,
                loanInfo.maturity,
                loanInfo.assets,
                collateralTokenIdSpec
            );
    }

    /**
     * @inheritdoc IPool
     */
    function sellNote(
        address noteToken,
        uint256 noteTokenId,
        uint256 minPurchasePrice,
        uint256[] calldata depths,
        bytes[] calldata collateralTokenIdSpec
    ) external returns (uint256) {
        /* Get note adapter */
        INoteAdapter noteAdapter = _getNoteAdapter(noteToken);

        /* Get loan ID */
        uint256 loanId = noteAdapter.getLoanId(noteTokenId);

        /* Get loan info */
        ILoanAdapter.LoanInfo memory loanInfo = noteAdapter.getLoanInfo(loanId, "");

        /* Validate loan status */
        if (noteAdapter.getLoanStatus(loanId, "") != ILoanAdapter.LoanStatus.Active) revert InvalidLoanStatus();

        /* Validate currency token */
        if (loanInfo.currencyToken != address(_currencyToken)) revert UnsupportedCurrencyToken();

        /* Validate loan duration */
        if (loanInfo.duration > _maxLoanDuration) revert UnsupportedLoanDuration();

        /* Price the note */
        uint256 purchasePrice = _priceNote(
            loanInfo.principal,
            loanInfo.repayment,
            loanInfo.maturity,
            loanInfo.assets,
            collateralTokenIdSpec
        );

        /* Validate purchase price */
        if (purchasePrice < minPurchasePrice) revert PurchasePriceTooLow();

        /* Source liquidity nodes */
        (ILiquidity.NodeSource[] memory nodes, uint16 count) = _liquidity.source(purchasePrice, depths);

        /* Distribute interest */
        (nodes, count) = _interestRateModel.distribute(purchasePrice, loanInfo.repayment - purchasePrice, nodes, count);

        /* Use liquidity nodes */
        LoanReceipt.NodeReceipt[] memory nodeReceipts = new LoanReceipt.NodeReceipt[](count);
        for (uint256 i; i < count; i++) {
            /* Use node */
            _liquidity.use(nodes[i].depth, nodes[i].used, nodes[i].pending);

            /* Construct node receipt */
            nodeReceipts[i] = LoanReceipt.NodeReceipt({
                depth: nodes[i].depth,
                used: nodes[i].used,
                pending: nodes[i].pending
            });
        }

        /* Update top level liquidity statistics */
        _liquidity.used += uint128(purchasePrice);

        /* Update utilization tracking */
        _interestRateModel.onUtilizationUpdated(utilization());

        /* Build loan receipt */
        LoanReceipt.LoanReceiptV1 memory loanReceipt = LoanReceipt.fromLoanInfo(noteToken, loanInfo, nodeReceipts);
        bytes memory encodedLoanReceipt = loanReceipt.encode();
        bytes32 loanReceiptHash = LoanReceipt.hash(encodedLoanReceipt);

        /* Store loan status */
        _loans[loanReceiptHash] = LoanStatus.Active;

        /* Transfer note token */
        IERC721(noteToken).safeTransferFrom(msg.sender, address(this), noteTokenId);

        /* Transafer cash */
        _currencyToken.safeTransfer(msg.sender, purchasePrice);

        /* Emit Loan Receipt */
        emit LoanPurchased(loanReceiptHash, encodedLoanReceipt);

        return purchasePrice;
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
        bytes[] calldata collateralTokenIdSpec
    ) public view returns (uint256) {
        /* FIXME implement bundle support */

        /* Verify collateral is supported */
        if (!_collateralFilter.supported(collateralToken, collateralTokenId, "")) revert UnsupportedCollateral(0);

        /* Validate loan duration */
        if (duration > _maxLoanDuration) revert UnsupportedLoanDuration();

        /* Calculate repayment from princiapl, rate, and duration */
        return
            Math.mulDiv(
                principal,
                LiquidityManager.FIXED_POINT_SCALE +
                    Math.mulDiv(
                        _interestRateModel.rate(),
                        duration * LiquidityManager.FIXED_POINT_SCALE,
                        LiquidityManager.FIXED_POINT_SCALE
                    ),
                LiquidityManager.FIXED_POINT_SCALE
            );
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
        uint256[] calldata depths,
        bytes[] calldata collateralTokenIdSpec,
        bytes calldata options
    ) external nonReentrant returns (uint256) {
        /* Quote repayment */
        uint256 repayment = quote(principal, duration, collateralToken, collateralTokenId, collateralTokenIdSpec);

        /* Validate repayment */
        if (repayment > maxRepayment) revert RepaymentTooHigh();

        /* Source liquidity nodes */
        (ILiquidity.NodeSource[] memory nodes, uint16 count) = _liquidity.source(principal, depths);

        /* Distribute interest */
        (nodes, count) = _interestRateModel.distribute(principal, repayment - principal, nodes, count);

        /* Build the loan receipt */
        LoanReceipt.LoanReceiptV1 memory receipt = LoanReceipt.LoanReceiptV1({
            version: 1,
            platform: address(this),
            loanId: 0,
            borrower: msg.sender,
            maturity: uint64(block.timestamp + duration),
            duration: duration,
            collateralToken: collateralToken,
            collateralTokenId: collateralTokenId,
            nodeReceipts: new LoanReceipt.NodeReceipt[](count)
        });

        /* Use liquidity nodes */
        for (uint256 i; i < count; i++) {
            /* Use node */
            _liquidity.use(nodes[i].depth, nodes[i].used, nodes[i].pending);

            /* Construct node receipt */
            receipt.nodeReceipts[i] = LoanReceipt.NodeReceipt({
                depth: nodes[i].depth,
                used: nodes[i].used,
                pending: nodes[i].pending
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
            _processBorrowOptions(collateralToken, collateralTokenId, options);
        }

        /* Transfer collateral from borrower to pool */
        IERC721(collateralToken).safeTransferFrom(msg.sender, address(this), collateralTokenId);

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

        /* Validate this is a pool loan */
        if (loanReceipt.platform != address(this)) revert InvalidLoanReceipt();

        /* Validate caller is borrower */
        if (msg.sender != loanReceipt.borrower) revert InvalidCaller();

        /* Validate loan is not expired */
        if (block.timestamp > loanReceipt.maturity) revert LoanExpired();

        /* Recompute repayment from pending nodes */
        uint256 repayment;
        for (uint256 i = 0; i < loanReceipt.nodeReceipts.length; i++) {
            repayment += loanReceipt.nodeReceipts[i].pending;
        }

        /* revoke delegate */
        _revokeDelegates(loanReceipt.collateralToken, loanReceipt.collateralTokenId);

        /* Transfer repayment from borrower to lender */
        _currencyToken.safeTransferFrom(loanReceipt.borrower, address(this), repayment);

        /* Transfer collateral from pool to borrower */
        IERC721(loanReceipt.collateralToken).safeTransferFrom(
            address(this),
            loanReceipt.borrower,
            loanReceipt.collateralTokenId
        );

        /* Mark loan repaid */
        _loans[loanReceiptHash] = LoanStatus.RepaidPending;

        /* Emit Loan Repaid */
        emit LoanRepaid(loanReceiptHash, false);
    }

    /**************************************************************************/
    /* Loan Callbacks */
    /**************************************************************************/

    /**
     * @inheritdoc IPool
     */
    function onLoanRepaid(bytes calldata encodedLoanReceipt) external {
        /* Compute loan receipt hash */
        bytes32 loanReceiptHash = LoanReceipt.hash(encodedLoanReceipt);

        /* Validate loan status is active or repaid and pending */
        if (_loans[loanReceiptHash] != LoanStatus.Active && _loans[loanReceiptHash] != LoanStatus.RepaidPending)
            revert InvalidLoanReceipt();

        /* Decode loan receipt */
        LoanReceipt.LoanReceiptV1 memory loanReceipt = LoanReceipt.decode(encodedLoanReceipt);

        /* If this is a pool loan */
        if (loanReceipt.platform == address(this)) {
            /* Validate loan is repaid */
            if (_loans[loanReceiptHash] != LoanStatus.RepaidPending) revert InvalidLoanReceipt();
        } else {
            /* Look up loan adapter */
            ILoanAdapter loanAdapter = this.loanAdapters(loanReceipt.platform);

            /* Validate loan is repaid with note adapter */
            if (loanAdapter.getLoanStatus(loanReceipt.loanId, encodedLoanReceipt) != ILoanAdapter.LoanStatus.Repaid)
                revert InvalidLoanStatus();
        }

        /* Restore liquidity nodes */
        uint128 totalPending;
        uint128 totalUsed;
        for (uint256 i; i < loanReceipt.nodeReceipts.length; i++) {
            /* Restore node */
            _liquidity.restore(
                loanReceipt.nodeReceipts[i].depth,
                loanReceipt.nodeReceipts[i].used,
                loanReceipt.nodeReceipts[i].pending,
                loanReceipt.nodeReceipts[i].pending
            );

            /* Track totals */
            totalPending += loanReceipt.nodeReceipts[i].pending;
            totalUsed += loanReceipt.nodeReceipts[i].used;
        }

        /* Update top level liquidity statistics */
        _liquidity.total += totalPending - totalUsed;
        _liquidity.used -= totalUsed;

        /* Update utilization tracking */
        _interestRateModel.onUtilizationUpdated(utilization());

        /* Mark loan status repaid */
        _loans[loanReceiptHash] = LoanStatus.Repaid;

        /* Emit Loan Repaid */
        emit LoanRepaid(loanReceiptHash, true);
    }

    /**
     * @inheritdoc IPool
     */
    function onLoanExpired(bytes calldata encodedLoanReceipt) external {
        /* Compute loan receipt hash */
        bytes32 loanReceiptHash = LoanReceipt.hash(encodedLoanReceipt);

        /* Validate loan status is active */
        if (_loans[loanReceiptHash] != LoanStatus.Active) revert InvalidLoanReceipt();

        /* Decode loan receipt */
        LoanReceipt.LoanReceiptV1 memory loanReceipt = LoanReceipt.decode(encodedLoanReceipt);

        /* If this is a pool loan */
        if (loanReceipt.platform == address(this)) {
            /* Validate loan is expired */
            if (block.timestamp < loanReceipt.maturity) revert InvalidLoanStatus();
        } else {
            /* Look up loan adapter */
            ILoanAdapter loanAdapter = this.loanAdapters(loanReceipt.platform);

            /* Validate loan is repaid with note adapter */
            if (loanAdapter.getLoanStatus(loanReceipt.loanId, encodedLoanReceipt) != ILoanAdapter.LoanStatus.Expired)
                revert InvalidLoanStatus();

            /* Liquidate loan with platform */
            (address target, bytes memory data) = loanAdapter.getLiquidateCalldata(
                loanReceipt.loanId,
                encodedLoanReceipt
            );
            if (target == address(0x0)) revert InvalidAddress();
            (bool success, ) = target.call(data);
            if (!success) revert CallFailed();
        }

        /* Transfer collateral to _collateralLiquidator */
        IERC721(loanReceipt.collateralToken).safeTransferFrom(
            address(this),
            address(_collateralLiquidator),
            loanReceipt.collateralTokenId,
            encodedLoanReceipt
        );

        /* Mark loan status liquidated */
        _loans[loanReceiptHash] = LoanStatus.Liquidated;

        /* revoke delegate */
        _revokeDelegates(loanReceipt.collateralToken, loanReceipt.collateralTokenId);

        /* Emit Loan Liquidated */
        emit LoanLiquidated(loanReceiptHash);
    }

    /**
     * @inheritdoc IPool
     */
    function onCollateralLiquidated(bytes calldata encodedLoanReceipt, uint256 proceeds) external {
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
    function deposit(uint256 depth, uint256 amount) external {
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
    function redeem(uint256 depth, uint256 shares) external {
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
    function withdraw(uint256 depth) external returns (uint256) {
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
     * @notice Set loan adapter contract
     *
     * Emits a {LoanAdapterUpdated} event.
     *
     * @param platform Note token or lend platform contract
     * @param loanAdapter Loan adapter contract
     */
    function setLoanAdapter(address platform, address loanAdapter) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (loanAdapter != address(0)) {
            _loanAdapters.set(platform, uint160(loanAdapter));
        } else {
            _loanAdapters.remove(platform);
        }

        /* Emit Loan Adapter Updated */
        emit LoanAdapterUpdated(platform, loanAdapter);
    }

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
