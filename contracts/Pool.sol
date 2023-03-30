// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.17;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/proxy/Clones.sol";
import "@openzeppelin/contracts/utils/introspection/ERC165.sol";
import "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import "@openzeppelin/contracts/utils/Address.sol";
import "@openzeppelin/contracts/utils/Multicall.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import "@openzeppelin/contracts/token/ERC721/utils/ERC721Holder.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

import "./LoanReceipt.sol";
import "./LiquidityManager.sol";
import "./CollateralFilter.sol";
import "./InterestRateModel.sol";

import "./interfaces/IPool.sol";
import "./interfaces/ILiquidity.sol";
import "./interfaces/ICollateralWrapper.sol";
import "./interfaces/ICollateralLiquidator.sol";

import "./integrations/DelegateCash/IDelegationRegistry.sol";

/**
 * @title Pool
 * @author MetaStreet Labs
 */
abstract contract Pool is
    ERC165,
    ERC721Holder,
    AccessControl,
    ReentrancyGuard,
    Multicall,
    CollateralFilter,
    InterestRateModel,
    IPool,
    ILiquidity
{
    using SafeERC20 for IERC20;
    using EnumerableSet for EnumerableSet.AddressSet;
    using LoanReceipt for LoanReceipt.LoanReceiptV1;
    using LiquidityManager for LiquidityManager.Liquidity;

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
     * @notice Basis points scale
     */
    uint256 internal constant BASIS_POINTS_SCALE = 10_000;

    /**
     * @notice Pool borrow options tag size in bytes
     */
    uint256 internal constant BORROW_OPTIONS_TAG_SIZE = 2;

    /**
     * @notice Pool borrow options length size in bytes
     */
    uint256 internal constant BORROW_OPTIONS_LENGTH_SIZE = 2;

    /**
     * @notice Pool borrow options header size in bytes
     */
    uint internal constant BORROW_OPTIONS_HEADER_SIZE = BORROW_OPTIONS_TAG_SIZE + BORROW_OPTIONS_LENGTH_SIZE;

    /**************************************************************************/
    /* Errors */
    /**************************************************************************/

    /**
     * @notice Invalid address
     */
    error InvalidAddress();

    /**
     * @notice Parameter out of bounds
     */
    error ParameterOutOfBounds();

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
        DelegateCash,
        CollateralWrapperContext
    }

    /**************************************************************************/
    /* Immutable State */
    /**************************************************************************/

    /**
     * @notice Delegation registry contract
     */
    IDelegationRegistry internal immutable _delegationRegistry;

    /**************************************************************************/
    /* State */
    /**************************************************************************/

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
     * @notice Origination fee rate in basis points
     */
    uint256 internal _originationFeeRate;

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
     * @notice Collateral liquidator contract
     */
    ICollateralLiquidator internal _collateralLiquidator;

    /**
     * @notice  Collateral wrappers mapping
     */
    EnumerableSet.AddressSet internal _collateralWrappers;

    /**************************************************************************/
    /* Constructor */
    /**************************************************************************/

    /**
     * @notice Pool constructor
     * @param delegationRegistry_ Delegation registry contract
     */
    constructor(address delegationRegistry_) {
        _delegationRegistry = IDelegationRegistry(delegationRegistry_);
    }

    /**************************************************************************/
    /* Initializer */
    /**************************************************************************/

    /**
     * @notice Pool initializer
     * @param collateralToken_ Collateral token contract
     * @param currencyToken_ Currency token contract
     * @param maxLoanDuration_ Maximum loan duration in seconds
     * @param originationFeeRate_ Origination fee rate in basis points
     * @param collateralLiquidator_ Collateral liquidator contract
     * @param collateralWrappers Collateral wrappers
     */
    function _initialize(
        address collateralToken_,
        address currencyToken_,
        uint64 maxLoanDuration_,
        uint256 originationFeeRate_,
        address[] memory collateralWrappers,
        address collateralLiquidator_
    ) internal {
        _collateralToken = IERC721(collateralToken_);
        _currencyToken = IERC20(currencyToken_); /* FIXME verify 18 decimals */
        _maxLoanDuration = maxLoanDuration_;
        _originationFeeRate = originationFeeRate_;
        _collateralLiquidator = ICollateralLiquidator(collateralLiquidator_);

        /* Set collateral wrappers */
        for (uint256 i = 0; i < collateralWrappers.length; i++) {
            _collateralWrappers.add(collateralWrappers[i]);
        }

        /* Initialize liquidity */
        _liquidity.initialize();

        /* Grant admin role */
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
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
    function collateralLiquidator() external view returns (address) {
        return address(_collateralLiquidator);
    }

    /**
     * @inheritdoc IPool
     */
    function delegationRegistry() external view returns (address) {
        return address(_delegationRegistry);
    }

    /**
     * @inheritdoc IPool
     */
    function supportedCollateralWrappers() external view returns (address[] memory) {
        return _collateralWrappers.values();
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
     * @notice Get total admin fee balance
     * @return Total admin fee balance
     */
    function adminFeeBalance() external view returns (uint256) {
        return _adminFeeBalance;
    }

    /**************************************************************************/
    /* Loan Receipt External Helpers */
    /**************************************************************************/

    /**
     * @notice Decode loan receipt
     * @param loanReceipt Loan receipt
     * @return Decoded loan receipt
     */
    function decodeLoanReceipt(bytes calldata loanReceipt) external pure returns (LoanReceipt.LoanReceiptV1 memory) {
        return LoanReceipt.decode(loanReceipt);
    }

    /**
     * @notice Hash loan receipt
     * @param loanReceipt Loan receipt
     * @return Hahshed loan receipt
     */
    function hashLoanReceipt(bytes calldata loanReceipt) external view returns (bytes32) {
        return LoanReceipt.hash(loanReceipt);
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
     * @notice Helper function that scans options data for the specified tag
     * and returns the associated data.
     *
     * @dev Options are encoded as:
     *   2 byte uint16 tag
     *   2 byte uint16 length
     *   n byte bytes  data
     * The first matching tag is returned.
     *
     * @param options Encoded options
     * @param tag Tag to find
     * @return Options data
     */
    function _getOptionsData(bytes calldata options, uint16 tag) internal pure returns (bytes calldata) {
        uint256 offset = 0;

        /* Scan the options for the tag */
        while (offset < options.length) {
            /* The tag is in the first 2 bytes of each options item */
            uint16 currentTag = uint16(bytes2(options[offset:BORROW_OPTIONS_TAG_SIZE]));

            /* The length of the options data is in the second 2 bytes of each options item, after the tag */
            uint256 dataLength = uint16(
                bytes2(options[offset + BORROW_OPTIONS_TAG_SIZE:offset + BORROW_OPTIONS_HEADER_SIZE])
            );

            /* Return the offset and length if the tag is found */
            if (currentTag == tag) {
                return options[BORROW_OPTIONS_HEADER_SIZE + offset:BORROW_OPTIONS_HEADER_SIZE + offset + dataLength];
            }

            /* Increment to next options item */
            offset += BORROW_OPTIONS_HEADER_SIZE + dataLength;
        }

        /* Explicit return if no tag found */
        return options[0:0];
    }

    /**
     * @notice Helper function that returns underlying collateral in (address, uint256[]) shape
     * @param collateralToken_ Collateral token, either underlying token or collateral wrapper
     * @param collateralTokenId Collateral token ID
     * @param collateralContext Collateral context
     */
    function _getUnderlyingCollateral(
        address collateralToken_,
        uint256 collateralTokenId,
        bytes memory collateralContext
    ) internal view returns (address, uint256[] memory) {
        /* Enumerate bundle if collateral token is a collateral wrapper */
        if (_collateralWrappers.contains(collateralToken_)) {
            return ICollateralWrapper(collateralToken_).enumerate(collateralTokenId, collateralContext);
        }

        /* If single asset, convert token id to to token id array */
        uint256[] memory underlyingCollateralTokenIds = new uint256[](1);
        underlyingCollateralTokenIds[0] = collateralTokenId;

        return (collateralToken_, underlyingCollateralTokenIds);
    }

    /**
     * @notice Helper function that calls delegate.cash registry to delegate token
     * @param collateralToken Collateral token
     * @param collateralTokenId Collateral token ID
     * @param options Options data
     */
    function _optionDelegateCash(address collateralToken, uint256 collateralTokenId, bytes calldata options) internal {
        /* Find delegate.cash tagged data in options */
        bytes calldata delegateData = _getOptionsData(options, uint16(BorrowOptions.DelegateCash));

        if (delegateData.length != 0) {
            if (address(_delegationRegistry) == address(0)) revert InvalidBorrowOptions();
            if (delegateData.length != 20) revert InvalidBorrowOptions();

            address delegate = address(uint160(bytes20(delegateData)));
            _delegationRegistry.delegateForToken(delegate, collateralToken, collateralTokenId, true);
        }
    }

    /**
     * @dev Helper function to revoke token delegate
     * @param collateralToken_ Contract address of token that delegation is being removed from
     * @param collateralTokenId Token id of token that delegation is being removed from
     */
    function _revokeDelegates(address collateralToken_, uint256 collateralTokenId) internal {
        /* No operation if _delegationRegistry not set */
        if (address(_delegationRegistry) == address(0)) return;

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

    /**
     * @dev Helper function to quote a loan
     * @param principal Principal amount in currency tokens
     * @param duration Duration in seconds
     * @param collateralToken_ Collateral token address
     * @param collateralTokenIds List of collateral token ids
     * @return Repayment amount in currency tokens
     */
    function _quote(
        uint256 principal,
        uint64 duration,
        address collateralToken_,
        uint256[] memory collateralTokenIds
    ) internal view returns (uint256) {
        /* Verify collateral is supported */
        for (uint256 i = 0; i < collateralTokenIds.length; i++) {
            if (!collateralSupported(collateralToken_, collateralTokenIds[i], "")) revert UnsupportedCollateral(i);
        }

        /* Validate loan duration */
        if (duration > _maxLoanDuration) revert UnsupportedLoanDuration();

        /* Calculate repayment from principal, rate, and duration */
        return
            Math.mulDiv(
                principal,
                LiquidityManager.FIXED_POINT_SCALE + (rate() * duration),
                LiquidityManager.FIXED_POINT_SCALE
            ) + Math.mulDiv(principal, _originationFeeRate, BASIS_POINTS_SCALE);
    }

    /**
     * @dev Helper function to calculated prorated repayment
     * @param loanReceipt Decoded loan receipt
     * @return Repayment amount in currency tokens, proration based on elapsed duration
     */
    function _prorateRepayment(LoanReceipt.LoanReceiptV1 memory loanReceipt) internal view returns (uint256, uint256) {
        /* Compute proration based on elapsed duration. Proration can't exceed
         * 1.0 due to the loan expiry check. */
        uint256 proration = Math.mulDiv(
            block.timestamp - (loanReceipt.maturity - loanReceipt.duration),
            LiquidityManager.FIXED_POINT_SCALE,
            loanReceipt.duration
        );

        /* Compute origination fee */
        uint256 originationFee = Math.mulDiv(loanReceipt.principal, _originationFeeRate, BASIS_POINTS_SCALE);

        /* Compute repayment using prorated interest */
        uint256 repayment = loanReceipt.principal +
            originationFee +
            Math.mulDiv(
                loanReceipt.repayment - originationFee - loanReceipt.principal,
                proration,
                LiquidityManager.FIXED_POINT_SCALE
            );

        return (repayment, proration);
    }

    /**
     * @dev Helper function to handle borrow accounting
     * @param principal Principal amount in currency tokens
     * @param duration Duration in seconds
     * @param collateralToken_ Collateral token address
     * @param collateralTokenId Collateral token id
     *  @param maxRepayment Maximum repayment amount in currency tokens
     * @param depths Liquidity node depths
     * @param collateralContext Collateral context data
     * @return Repayment Amount in currency tokens
     * @return EncodedLoanReceipt Encoded loan receipt
     * @return LoanReceiptHash Loan receipt hash
     */
    function _borrow(
        uint256 principal,
        uint64 duration,
        address collateralToken_,
        uint256 collateralTokenId,
        uint256 maxRepayment,
        uint256[] calldata depths,
        bytes memory collateralContext
    ) internal returns (uint256, bytes memory, bytes32) {
        /* Get underlying collateral */
        (address underlyingCollateralToken, uint256[] memory underlyingCollateralTokenIds) = _getUnderlyingCollateral(
            collateralToken_,
            collateralTokenId,
            collateralContext
        );

        /* Quote repayment */
        uint256 repayment = _quote(principal, duration, underlyingCollateralToken, underlyingCollateralTokenIds);

        /* Validate repayment */
        if (repayment > maxRepayment) revert RepaymentTooHigh();

        /* Source liquidity nodes */
        (ILiquidity.NodeSource[] memory nodes, uint16 count) = _liquidity.source(principal, depths);

        /* Compute admin fee */
        uint256 adminFee = Math.mulDiv(_adminFeeRate, repayment - principal, BASIS_POINTS_SCALE);

        /* Distribute interest */
        uint128[] memory interest = distribute(principal, repayment - principal - adminFee, nodes, count);

        /* Build the loan receipt */
        LoanReceipt.LoanReceiptV1 memory receipt = LoanReceipt.LoanReceiptV1({
            version: 1,
            principal: principal,
            repayment: repayment,
            borrower: msg.sender,
            maturity: uint64(block.timestamp + duration),
            duration: duration,
            collateralToken: collateralToken_,
            collateralTokenId: collateralTokenId,
            collateralContextLength: uint16(collateralContext.length),
            collateralContextData: collateralContext,
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
        _onUtilizationUpdated(utilization());

        /* Encode and hash the loan receipt */
        bytes memory encodedLoanReceipt = receipt.encode();
        bytes32 loanReceiptHash = LoanReceipt.hash(encodedLoanReceipt);

        /* Validate no loan receipt hash collision */
        if (_loans[loanReceiptHash] != LoanStatus.Uninitialized) revert InvalidLoanReceipt();

        /* Store loan status */
        _loans[loanReceiptHash] = LoanStatus.Active;

        return (repayment, encodedLoanReceipt, loanReceiptHash);
    }

    /**
     * @dev Helper function to handle repay accounting
     * @param encodedLoanReceipt Encoded loan receipt
     * @return LoanReceipt Decoded loan receipt
     * @return LoanReceiptHash Loan receipt hash
     * @return Repayment Amount in currency tokens
     */
    function _repay(
        bytes calldata encodedLoanReceipt
    ) internal returns (LoanReceipt.LoanReceiptV1 memory, bytes32, uint256) {
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

        /* Compute proration and repayment using prorated interest */
        (uint256 repayment, uint256 proration) = _prorateRepayment(loanReceipt);

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
        _onUtilizationUpdated(utilization());

        /* Mark loan status repaid */
        _loans[loanReceiptHash] = LoanStatus.Repaid;

        return (loanReceipt, loanReceiptHash, repayment);
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
        uint256[] calldata collateralTokenIds,
        bytes calldata options
    ) external view returns (uint256) {
        options;

        /* Check principal doesn't exceed max borrow available */
        if (principal > _liquidity.liquidityAvailable(type(uint256).max))
            revert LiquidityManager.InsufficientLiquidity();

        return _quote(principal, duration, address(_collateralToken), collateralTokenIds);
    }

    /**
     * @inheritdoc IPool
     */
    function quoteRefinance(
        bytes calldata encodedLoanReceipt,
        uint256 principal,
        uint64 duration
    ) external view returns (int256, uint256) {
        /* Check principal doesn't exceed max borrow available */
        if (principal > _liquidity.liquidityAvailable(type(uint256).max))
            revert LiquidityManager.InsufficientLiquidity();

        /* Decode loan receipt */
        LoanReceipt.LoanReceiptV1 memory loanReceipt = LoanReceipt.decode(encodedLoanReceipt);

        /* Get underlying collateral */
        (address underlyingCollateralToken, uint256[] memory underlyingCollateralTokenIds) = _getUnderlyingCollateral(
            loanReceipt.collateralToken,
            loanReceipt.collateralTokenId,
            loanReceipt.collateralContextData
        );

        /* Quote repayment */
        uint256 newRepayment = _quote(principal, duration, underlyingCollateralToken, underlyingCollateralTokenIds);

        /* Compute repayment using prorated interest */
        (uint256 proratedRepayment, ) = _prorateRepayment(loanReceipt);

        return (int256(proratedRepayment) - int256(principal), newRepayment);
    }

    /**
     * @inheritdoc IPool
     */
    function borrow(
        uint256 principal,
        uint64 duration,
        address collateralToken_,
        uint256 collateralTokenId,
        uint256 maxRepayment,
        uint256[] calldata depths,
        bytes calldata options
    ) external nonReentrant returns (uint256) {
        /* Handle borrow accounting */
        (uint256 repayment, bytes memory encodedLoanReceipt, bytes32 loanReceiptHash) = _borrow(
            principal,
            duration,
            collateralToken_,
            collateralTokenId,
            maxRepayment,
            depths,
            _getOptionsData(options, uint16(BorrowOptions.CollateralWrapperContext))
        );

        /* Handle delegate.cash option */
        _optionDelegateCash(collateralToken_, collateralTokenId, options);

        /* Transfer collateral from borrower to pool */
        IERC721(collateralToken_).transferFrom(msg.sender, address(this), collateralTokenId);

        /* Transfer principal from pool to borrower */
        _currencyToken.safeTransfer(msg.sender, principal);

        /* Emit LoanOriginated */
        emit LoanOriginated(loanReceiptHash, encodedLoanReceipt);

        return repayment;
    }

    /**
     * @inheritdoc IPool
     */
    function repay(bytes calldata encodedLoanReceipt) external nonReentrant {
        /* Handle repay accounting */
        (LoanReceipt.LoanReceiptV1 memory loanReceipt, bytes32 loanReceiptHash, uint256 repayment) = _repay(
            encodedLoanReceipt
        );

        /* Revoke delegates */
        _revokeDelegates(loanReceipt.collateralToken, loanReceipt.collateralTokenId);

        /* Transfer repayment from borrower to lender */
        _currencyToken.safeTransferFrom(loanReceipt.borrower, address(this), repayment);

        /* Transfer collateral from pool to borrower */
        IERC721(loanReceipt.collateralToken).transferFrom(
            address(this),
            loanReceipt.borrower,
            loanReceipt.collateralTokenId
        );

        /* Emit Loan Repaid */
        emit LoanRepaid(loanReceiptHash, repayment);
    }

    /**
     * @inheritdoc IPool
     */

    function refinance(
        bytes calldata encodedLoanReceipt,
        uint256 principal,
        uint64 duration,
        uint256 maxRepayment,
        uint256[] calldata depths
    ) external nonReentrant returns (uint256) {
        /* Handle repay accounting without revoking delegates unlike in repay() */
        (LoanReceipt.LoanReceiptV1 memory loanReceipt, bytes32 loanReceiptHash, uint256 repayment) = _repay(
            encodedLoanReceipt
        );

        /* Handle borrow accounting without delegating unlike in borrow() */
        (uint256 newRepayment, bytes memory newEncodedLoanReceipt, bytes32 newLoanReceiptHash) = _borrow(
            principal,
            duration,
            loanReceipt.collateralToken,
            loanReceipt.collateralTokenId,
            maxRepayment,
            depths,
            loanReceipt.collateralContextData
        );

        /* Determine transfer direction */
        if (principal < repayment) {
            /* Transfer prorated repayment less principal from borrower to pool */
            _currencyToken.safeTransferFrom(loanReceipt.borrower, address(this), repayment - principal);
        } else {
            /* Transfer principal less prorated repayment from pool to borrower */
            _currencyToken.safeTransfer(msg.sender, principal - repayment);
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
        /* Compute loan receipt hash */
        bytes32 loanReceiptHash = LoanReceipt.hash(encodedLoanReceipt);

        /* Validate loan status is active */
        if (_loans[loanReceiptHash] != LoanStatus.Active) revert InvalidLoanReceipt();

        /* Decode loan receipt */
        LoanReceipt.LoanReceiptV1 memory loanReceipt = LoanReceipt.decode(encodedLoanReceipt);

        /* Validate loan is expired */
        if (block.timestamp < loanReceipt.maturity) revert LoanNotExpired();

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
        _onUtilizationUpdated(utilization());

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
        _onUtilizationUpdated(utilization());

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
        _onUtilizationUpdated(utilization());

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
    /* Admin Fees API */
    /**************************************************************************/

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
