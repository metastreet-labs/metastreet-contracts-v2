// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.17;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/security/Pausable.sol";
import "@openzeppelin/contracts/utils/introspection/ERC165.sol";
import "@openzeppelin/contracts/utils/structs/EnumerableMap.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC721/utils/ERC721Holder.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

import "./interfaces/IPool.sol";
import "./LoanReceipt.sol";
import "./LiquidityManager.sol";

/**
 * @title Pool
 * @author MetaStreet Labs
 */
contract Pool is LiquidityManager, ERC165, ERC721Holder, AccessControl, Pausable, IPool {
    using SafeERC20 for IERC20;
    using EnumerableMap for EnumerableMap.AddressToUintMap;
    using LoanReceipt for LoanReceipt.LoanReceiptV1;

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
     * @notice Invalid caller
     */
    error InvalidCaller();

    /**
     * @notice Invalid shares
     */
    error InvalidShares();

    /**
     * @notice Unsupported platform
     */
    error UnsupportedPlatform();

    /**
     * @notice Redemption in progress
     */
    error RedemptionInProgress();

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
        Liquidated
    }

    /**
     * @notice Loan
     * @param status Loan status
     * @param receiptHash Loan receipt hash
     */
    struct Loan {
        LoanStatus status;
        bytes31 receiptHash;
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
     * @notice Mapping of account to loan limit depth to deposit
     */
    mapping(address => mapping(uint128 => Deposit)) internal _deposits;

    /**
     * @notice Mapping of loan ID to Loan
     */
    mapping(uint256 => Loan) internal _loans;

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
     * @notice Get loan
     * @param loanId Loan ID
     * @return Loan information
     */
    function loans(uint256 loanId) external view returns (Loan memory) {
        return _loans[loanId];
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
     * @param duration Duration
     * @param assets Collateral assets
     * @param collateralTokenIdSpec Collateral token ID specification
     * @return purchasePrice Purchase price
     * @return trail Liquidity trail
     */
    function _priceNote(
        uint256 principal,
        uint256 repayment,
        uint64 duration,
        ILoanAdapter.AssetInfo[] memory assets,
        bytes[] calldata collateralTokenIdSpec
    ) internal view returns (uint256 purchasePrice, ILiquidityManager.LiquiditySource[] memory trail) {
        principal;
        repayment;
        duration;
        assets;
        collateralTokenIdSpec;
        revert("Not implemented");
    }

    /**
     * @inheritdoc IPool
     */
    function priceNote(
        address noteToken,
        uint256 noteTokenId,
        bytes[] calldata collateralTokenIdSpec
    ) external view returns (uint256 purchasePrice) {
        noteToken;
        noteTokenId;
        collateralTokenIdSpec;
        revert("Not implemented");
    }

    /**
     * @inheritdoc IPool
     */
    function sellNote(
        address noteToken,
        uint256 noteTokenId,
        uint256 minPurchasePrice,
        bytes[] calldata collateralTokenIdSpec
    ) external returns (uint256 purchasePrice) {
        noteToken;
        noteTokenId;
        minPurchasePrice;
        collateralTokenIdSpec;
        revert("Not implemented");
    }

    /**************************************************************************/
    /* Lend API */
    /**************************************************************************/

    function _priceLoan(
        uint256 principal,
        uint64 duration,
        ILoanAdapter.AssetInfo[] memory assets,
        bytes[] calldata collateralTokenIdSpec
    ) internal view returns (uint256 repayment, ILiquidityManager.LiquiditySource[] memory trail) {
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
    ) external view returns (uint256 repayment) {
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
    ) external returns (uint256 loanId) {
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
    function onLoanRepaid(bytes calldata loanReceipt) external {
        loanReceipt;
        revert("Not implemented");
    }

    /**
     * @inheritdoc IPool
     */
    function onLoanExpired(bytes calldata loanReceipt) external {
        loanReceipt;
        revert("Not implemented");
    }

    /**
     * @inheritdoc IPool
     */
    function onCollateralLiquidated(bytes calldata loanReceipt, uint256 proceeds) external {
        loanReceipt;
        proceeds;
        revert("Not implemented");
    }

    /**************************************************************************/
    /* Deposit API */
    /**************************************************************************/

    /**
     * @inheritdoc IPool
     */
    function deposit(uint256 depth, uint256 amount) external {
        /* Instantiate liquidity node */
        _liquidityInstantiate(uint128(depth));

        /* Deposit into liquidity node */
        uint128 shares = _liquidityDeposit(uint128(depth), uint128(amount));

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
        (uint128 redemptionIndex, uint128 redemptionTarget) = _liquidityRedeem(uint128(depth), uint128(shares));

        /* Update deposit state */
        dep.redemptionPending = uint128(shares);
        dep.redemptionIndex = redemptionIndex;
        dep.redemptionTarget = redemptionTarget;

        /* Process redemptions from available cash */
        (, uint128 amountRedeemed) = _liquidityProcessRedemptions(uint128(depth));

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
            _liquidityRedemptionAvailable(
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
        (uint128 shares, uint128 amount) = _liquidityRedemptionAvailable(
            uint128(depth),
            dep.redemptionPending,
            dep.redemptionIndex,
            dep.redemptionTarget
        );

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
