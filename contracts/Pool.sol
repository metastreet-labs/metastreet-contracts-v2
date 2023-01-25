// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.17;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/security/Pausable.sol";
import "@openzeppelin/contracts/utils/introspection/ERC165.sol";
import "@openzeppelin/contracts/utils/structs/EnumerableMap.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import "@openzeppelin/contracts/token/ERC721/utils/ERC721Holder.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

import "./interfaces/IPool.sol";
import "./interfaces/ILiquidity.sol";
import "./LoanReceipt.sol";
import "./LiquidityManager.sol";

/**
 * @title Pool
 * @author MetaStreet Labs
 */
contract Pool is ERC165, ERC721Holder, AccessControl, Pausable, IPool, ILiquidity {
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

    /**************************************************************************/
    /* State */
    /**************************************************************************/

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
     * @notice Set of supported loan adapters
     */
    EnumerableMap.AddressToUintMap internal _loanAdapters;

    /**************************************************************************/
    /* Constructor */
    /**************************************************************************/

    /**
     * @notice Pool constructor
     * @param currencyToken_ Currency token contract
     * @param maxLoanDuration_ Maximum loan duration in seconds
     * @param collateralFilter_ Collateral filter contract
     * @param interestRateModel_ Interest rate model contract
     * @param collateralLiquidator_ Collateral liquidator contract
     */
    constructor(
        IERC20 currencyToken_,
        uint64 maxLoanDuration_,
        ICollateralFilter collateralFilter_,
        IInterestRateModel interestRateModel_,
        ICollateralLiquidator collateralLiquidator_
    ) {
        /* FIXME verify 18 decimals */
        _currencyToken = currencyToken_;
        _maxLoanDuration = maxLoanDuration_;
        _collateralFilter = collateralFilter_;
        _interestRateModel = interestRateModel_;
        _collateralLiquidator = collateralLiquidator_;
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
    function loanAdapters(address platform) external view returns (ILoanAdapter) {
        if (!_loanAdapters.contains(platform)) revert UnsupportedPlatform();
        return ILoanAdapter(address(uint160(_loanAdapters.get(platform))));
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
        return Math.mulDiv(_liquidity.used, LiquidityManager.FIXED_POINT_SCALE, _liquidity.value);
    }

    /**
     * @inheritdoc ILiquidity
     */
    function liquidityTotals() external view returns (uint256, uint256) {
        return (_liquidity.value, _liquidity.used);
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
    function liquidityNodes(uint256 startDepth, uint256 endDepth) external view returns (LiquidityNodeInfo[] memory) {
        return _liquidity.liquidityNodes(startDepth, endDepth);
    }

    /**
     * @inheritdoc ILiquidity
     */
    function liquidityNodeIsSolvent(uint256 depth) external view returns (bool) {
        return _liquidity.liquidityNodeIsSolvent(depth);
    }

    /**
     * @inheritdoc ILiquidity
     */
    function liquidityNodeIsActive(uint256 depth) external view returns (bool) {
        return _liquidity.liquidityNodeIsActive(depth);
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
        if (loanAdapter.getAdapterType() != ILoanAdapter.AdapterType.Note) revert UnsupportedPlatform();
        return INoteAdapter(address(loanAdapter));
    }

    /**
     * @dev Helper function to safely get a lend adapter
     * @param lendPlatform Lend platform
     * @return Lend adapter
     */
    function _getLendAdapter(address lendPlatform) internal view returns (ILendAdapter) {
        ILoanAdapter loanAdapter = this.loanAdapters(lendPlatform);
        if (loanAdapter.getAdapterType() != ILoanAdapter.AdapterType.Lend) revert UnsupportedPlatform();
        return ILendAdapter(address(loanAdapter));
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
     * @return purchasePrice Purchase price
     * @return trail Liquidity trail
     */
    function _priceNote(
        uint256 principal,
        uint256 repayment,
        uint64 maturity,
        ILoanAdapter.AssetInfo[] memory assets,
        bytes[] calldata collateralTokenIdSpec
    ) internal view returns (uint256, ILiquidity.LiquiditySource[] memory) {
        /* FIXME implement bundle support */
        require(assets.length == 1, "Bundles not yet supported");

        /* Verify collateral is supported */
        if (!_collateralFilter.supported(assets[0].token, assets[0].tokenId, collateralTokenIdSpec[0]))
            revert UnsupportedCollateral(0);

        /* Calculate number of ticks needed for repayment */
        (uint16 nodesUsed, uint16 nodesTotal) = _liquidity.forecast(0, uint128(repayment));

        /* FIXME verify num nodes to ensure sufficient tranching */
        /* if (nodesUsed < MIN_NUM_NODES) revert InsufficientTranching(); */

        /* Calculate overall interest rate */
        uint256 rate = _interestRateModel.calculateRate(nodesUsed, nodesTotal);

        /* Calculate purchase price from repayment, rate, and remaining duration */
        uint256 purchasePrice = Math.mulDiv(
            repayment,
            LiquidityManager.FIXED_POINT_SCALE,
            Math.mulDiv(rate, maturity - uint64(block.timestamp), LiquidityManager.FIXED_POINT_SCALE)
        );

        /* Source liquidity */
        LiquiditySource[] memory trail = _liquidity.source(0, uint128(purchasePrice));

        /* Distribute interest */
        _interestRateModel.distributeInterest(uint128(repayment - purchasePrice), trail);

        return (purchasePrice, trail);
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

        /* Get loan info */
        ILoanAdapter.LoanInfo memory loanInfo = noteAdapter.getLoanInfo(noteAdapter.getLoanId(noteTokenId), "");

        /* Validate currency token */
        if (loanInfo.currencyToken != address(_currencyToken)) revert UnsupportedCurrencyToken();

        /* Validate loan duration */
        if (loanInfo.duration > _maxLoanDuration) revert UnsupportedLoanDuration();

        /* Price the note */
        (uint256 purchasePrice, ) = _priceNote(
            loanInfo.principal,
            loanInfo.repayment,
            loanInfo.maturity,
            loanInfo.assets,
            collateralTokenIdSpec
        );

        return purchasePrice;
    }

    /**
     * @inheritdoc IPool
     */
    function sellNote(
        address noteToken,
        uint256 noteTokenId,
        uint256 minPurchasePrice,
        bytes[] calldata collateralTokenIdSpec
    ) external returns (uint256) {
        /* Get note adapter */
        INoteAdapter noteAdapter = _getNoteAdapter(noteToken);

        /* Get loan info */
        ILoanAdapter.LoanInfo memory loanInfo = noteAdapter.getLoanInfo(noteAdapter.getLoanId(noteTokenId), "");

        /* Validate currency token */
        if (loanInfo.currencyToken != address(_currencyToken)) revert UnsupportedCurrencyToken();

        /* Validate loan duration */
        if (loanInfo.duration > _maxLoanDuration) revert UnsupportedLoanDuration();

        /* Price the note */
        (uint256 purchasePrice, LiquiditySource[] memory trail) = _priceNote(
            loanInfo.principal,
            loanInfo.repayment,
            loanInfo.maturity,
            loanInfo.assets,
            collateralTokenIdSpec
        );

        /* Validate purchase price */
        if (purchasePrice < minPurchasePrice) revert PurchasePriceTooLow();

        /* Use nodes in liquidity trail */
        for (uint256 i; trail[i].depth != 0; i++) {
            _liquidity.use(trail[i].depth, trail[i].used, trail[i].pending);
        }

        /* Update utilization tracking */
        _interestRateModel.onUtilizationUpdated(utilization());

        /* Build loan receipt */
        LoanReceipt.LoanReceiptV1 memory loanReceipt = LoanReceipt.fromLoanInfo(noteToken, loanInfo, trail);
        bytes memory encodedLoanReceipt = loanReceipt.encode();
        bytes32 loanReceiptHash = LoanReceipt.hash(encodedLoanReceipt);

        /* Store loan status */
        _loans[loanReceiptHash] = LoanStatus.Active;

        /* Transfer collateral */
        IERC721(loanInfo.collateralToken).safeTransferFrom(msg.sender, address(this), loanInfo.collateralTokenId);

        /* Transafer cash */
        _currencyToken.safeTransferFrom(address(this), msg.sender, purchasePrice);

        /* Emit Loan Receipt */
        emit LoanPurchased(loanReceiptHash, encodedLoanReceipt);

        return purchasePrice;
    }

    /**************************************************************************/
    /* Lend API */
    /**************************************************************************/

    function _priceLoan(
        uint256 principal,
        uint64 duration,
        ILoanAdapter.AssetInfo[] memory assets,
        bytes[] calldata collateralTokenIdSpec
    ) internal view returns (uint256, ILiquidity.LiquiditySource[] memory) {
        principal;
        duration;
        assets;
        collateralTokenIdSpec;
        revert("Not implemented");
    }

    /**
     * @inheritdoc IPool
     */
    function priceLoan(
        address lendPlatform,
        uint256 principal,
        uint64 duration,
        address collateralToken,
        uint256 collateralTokenId,
        bytes[] calldata collateralTokenIdSpec
    ) external view returns (uint256) {
        lendPlatform;
        principal;
        duration;
        collateralToken;
        collateralTokenId;
        collateralTokenIdSpec;
        revert("Not implemented");
    }

    /**
     * @inheritdoc IPool
     */
    function originateLoan(
        address lendPlatform,
        uint256 principal,
        uint64 duration,
        address collateralToken,
        uint256 collateralTokenId,
        uint256 maxRepayment,
        bytes[] calldata collateralTokenIdSpec
    ) external returns (uint256) {
        lendPlatform;
        principal;
        duration;
        collateralToken;
        collateralTokenId;
        maxRepayment;
        collateralTokenId;
        collateralTokenIdSpec;
        revert("Not implemented");
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

        /* Validate loan status is active */
        if (_loans[loanReceiptHash] != LoanStatus.Active) revert InvalidLoanReceipt();

        /* Decode loan receipt */
        LoanReceipt.LoanReceiptV1 memory loanReceipt = LoanReceipt.decode(encodedLoanReceipt);

        /* Look up loan adapter */
        ILoanAdapter loanAdapter = this.loanAdapters(loanReceipt.platform);

        /* Validate loan is repaid with note adapter */
        if (loanAdapter.getLoanStatus(loanReceipt.loanId, encodedLoanReceipt) != ILoanAdapter.LoanStatus.Repaid)
            revert InvalidLoanStatus();

        /* Restore nodes in liquidity trail */
        for (uint256 i; i < loanReceipt.liquidityTrail.length; i++) {
            _liquidity.restore(
                loanReceipt.liquidityTrail[i].depth,
                loanReceipt.liquidityTrail[i].used,
                loanReceipt.liquidityTrail[i].pending,
                loanReceipt.liquidityTrail[i].pending
            );
        }

        /* Update utilization tracking */
        _interestRateModel.onUtilizationUpdated(utilization());

        /* Mark loan status repaid */
        _loans[loanReceiptHash] = LoanStatus.Repaid;

        /* Emit Loan Repaid */
        emit LoanRepaid(loanReceiptHash);
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

        /* Look up loan adapter */
        ILoanAdapter loanAdapter = this.loanAdapters(loanReceipt.platform);

        /* Validate loan is repaid with note adapter */
        if (loanAdapter.getLoanStatus(loanReceipt.loanId, encodedLoanReceipt) != ILoanAdapter.LoanStatus.Expired)
            revert InvalidLoanStatus();

        /* Liquidate loan with platform */
        (address target, bytes memory data) = loanAdapter.getLiquidateCalldata(loanReceipt.loanId, encodedLoanReceipt);
        if (target == address(0x0)) revert InvalidAddress();
        (bool success, ) = target.call(data);
        if (!success) revert CallFailed();

        /* Transfer collateral to _collateralLiquidator */
        IERC721(loanReceipt.collateralToken).safeTransferFrom(
            address(this),
            address(_collateralLiquidator),
            loanReceipt.collateralTokenId,
            encodedLoanReceipt
        );

        /* Mark loan status liquidated */
        _loans[loanReceiptHash] = LoanStatus.Liquidated;

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

        /* Restore nodes in liquidity trail */
        uint256 proceedsRemaining = proceeds;
        for (uint256 i; i < loanReceipt.liquidityTrail.length; i++) {
            uint128 restored = uint128(Math.min(loanReceipt.liquidityTrail[i].pending, proceedsRemaining));
            _liquidity.restore(
                loanReceipt.liquidityTrail[i].depth,
                loanReceipt.liquidityTrail[i].used,
                loanReceipt.liquidityTrail[i].pending,
                restored
            );
            proceedsRemaining -= restored;
        }

        /* Update utilization tracking */
        _interestRateModel.onUtilizationUpdated(utilization());

        /* Mark loan status collateral liquidated */
        _loans[loanReceiptHash] = LoanStatus.CollateralLiquidated;

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

        /* Transfer Deposit Amount */
        _currencyToken.safeTransferFrom(msg.sender, address(this), amount);

        /* Emit deposited event */
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

        /* Emit Withdrawn event */
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
