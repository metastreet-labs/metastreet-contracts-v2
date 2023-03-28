// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "./ICollateralFilter.sol";
import "./IInterestRateModel.sol";
import "./ICollateralLiquidator.sol";
import "./ICollateralWrapper.sol";

/**
 * @title Interface to a Pool
 */
interface IPool {
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
     * @notice Invalid loan receipt
     */
    error InvalidLoanReceipt();

    /**
     * @notice Invalid borrow options
     */
    error InvalidBorrowOptions();

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
     * @notice Repayment too high
     */
    error RepaymentTooHigh();

    /**
     * @notice Loan not expired
     */
    error LoanNotExpired();

    /**
     * @notice Loan expired
     */
    error LoanExpired();

    /**
     * @notice Redemption in progress
     */
    error RedemptionInProgress();

    /**************************************************************************/
    /* Events */
    /**************************************************************************/

    /**
     * @notice Emitted when currency is deposited
     * @param account Account
     * @param depth Loan limit depth
     * @param amount Amount of currency tokens
     * @param shares Amount of shares allocated
     */
    event Deposited(address indexed account, uint256 indexed depth, uint256 amount, uint256 shares);

    /**
     * @notice Emitted when deposit shares are redeemed
     * @param account Account
     * @param depth Loan limit depth
     * @param shares Amount of shares to be redeemed
     */
    event Redeemed(address indexed account, uint256 indexed depth, uint256 shares);

    /**
     * @notice Emitted when redeemed currency tokens are withdrawn
     * @param account Account
     * @param depth Loan limit depth
     * @param shares Amount of shares redeemed
     * @param amount Amount of currency tokens withdrawn
     */
    event Withdrawn(address indexed account, uint256 indexed depth, uint256 shares, uint256 amount);

    /**
     * @notice Emitted when a loan is originated
     * @param loanReceiptHash Loan receipt hash
     * @param loanReceipt Loan receipt
     */
    event LoanOriginated(bytes32 indexed loanReceiptHash, bytes loanReceipt);

    /**
     * @notice Emitted when a loan is repaid
     * @param loanReceiptHash Loan receipt hash
     * @param repayment Repayment amount in currency tokens
     */
    event LoanRepaid(bytes32 indexed loanReceiptHash, uint256 repayment);

    /**
     * @notice Emitted when a loan is liquidated
     * @param loanReceiptHash Loan receipt hash
     */
    event LoanLiquidated(bytes32 indexed loanReceiptHash);

    /**
     * @notice Emitted when loan collateral is liquidated
     * @param loanReceiptHash Loan receipt hash
     * @param proceeds Liquidation proceeds in currency tokens
     */
    event CollateralLiquidated(bytes32 indexed loanReceiptHash, uint256 proceeds);

    /**
     * @notice Emitted when admin fee rate is updated
     * @param rate New admin fee rate in basis points
     */
    event AdminFeeRateUpdated(uint256 rate);

    /**
     * @notice Emitted when admin fees are withdrawn
     * @param account Recipient account
     * @param amount Amount of currency tokens withdrawn
     */
    event AdminFeesWithdrawn(address indexed account, uint256 amount);

    /**************************************************************************/
    /* Getters */
    /**************************************************************************/

    /**
     * @notice Get collateral token
     * @return Collateral token contract
     */
    function collateralToken() external view returns (address);

    /**
     * @notice Get currency token
     * @return Currency token contract
     */
    function currencyToken() external view returns (address);

    /**
     * @notice Get maximum loan duration
     * @return Maximum loan duration in seconds
     */
    function maxLoanDuration() external view returns (uint64);

    /**
     * @notice Get admin fee rate
     * @return Admin fee rate in basis points
     */
    function adminFeeRate() external view returns (uint256);

    /**
     * @notice Get collateral filter contract
     * @return Collateral filter contract
     */
    function collateralFilter() external view returns (ICollateralFilter);

    /**
     * @notice Get interest rate model contract
     * @return Interest rate model contract
     */
    function interestRateModel() external view returns (IInterestRateModel);

    /**
     * @notice Get collateral liquidator contract
     * @return Collateral liquidator contract
     */
    function collateralLiquidator() external view returns (ICollateralLiquidator);

    /**
     * @notice Get delegation registry contract
     * @return Delegation registry contract
     */
    function delegationRegistry() external view returns (address);

    /**
     * @notice Get list of supported collateral wrappers
     * @return Collateral wrappers
     */
    function supportedCollateralWrappers() external view returns (address[] memory);

    /**************************************************************************/
    /* Lend API */
    /**************************************************************************/

    /**
     * @notice Quote repayment for a loan
     * @param principal Principal amount in currency tokens
     * @param duration Duration in seconds
     * @param collateralTokenIds List of collateral token ids
     * @return Repayment amount in currency tokens
     */
    function quote(
        uint256 principal,
        uint64 duration,
        uint256[] calldata collateralTokenIds
    ) external view returns (uint256);

    /**
     * @notice Quote repayment for a loan with a collateral wrapper token
     * @param principal Principal amount in currency tokens
     * @param duration Duration in seconds
     * @param collateralWrapperToken Collateral token
     * @param collateralWrapperTokenId Collateral token ID
     * @param collateralWrapperContext Collateral wrapper context
     * @return Repayment amount in currency tokens
     */
    function quote(
        uint256 principal,
        uint64 duration,
        address collateralWrapperToken,
        uint256 collateralWrapperTokenId,
        bytes calldata collateralWrapperContext
    ) external view returns (uint256);

    /**
     * @notice Quote refinancing for a loan
     *
     * @param encodedLoanReceipt Encoded loan receipt
     * @param principal New principal amount in currency tokens
     * @param duration Duration in seconds
     * @return downpayment Downpayment in currency tokens (positive for downpayment, negative for credit)
     * @return repayment Repayment amount in currency tokens for new loan
     */
    function quoteRefinance(
        bytes calldata encodedLoanReceipt,
        uint256 principal,
        uint64 duration
    ) external view returns (int256 downpayment, uint256 repayment);

    /**
     * @notice Originate a loan
     *
     * Emits a {LoanOriginated} event.
     *
     * @param principal Principal amount in currency tokens
     * @param duration Duration in seconds
     * @param collateralToken Collateral token address
     * @param collateralTokenId Collateral token ID
     * @param maxRepayment Maximum repayment amount in currency tokens
     * @param depths Liquidity node depths
     * @param options Encoded options
     * @return Repayment amount in currency tokens
     */
    function borrow(
        uint256 principal,
        uint64 duration,
        address collateralToken,
        uint256 collateralTokenId,
        uint256 maxRepayment,
        uint256[] calldata depths,
        bytes calldata options
    ) external returns (uint256);

    /**
     * @notice Repay a loan
     *
     * Emits a {LoanRepaid} event.
     *
     * @param encodedLoanReceipt Encoded loan receipt
     */
    function repay(bytes calldata encodedLoanReceipt) external;

    /**
     * @notice Refinance a loan
     *
     * Emits a {LoanRepaid} event and a {LoanOriginated} event.
     *
     * @param encodedLoanReceipt Encoded loan receipt
     * @param principal Principal amount in currency tokens
     * @param duration Duration in seconds
     * @param maxRepayment Maximum repayment amount in currency tokens
     * @param depths Liquidity node depths
     * @return Repayment amount in currency tokens
     */
    function refinance(
        bytes calldata encodedLoanReceipt,
        uint256 principal,
        uint64 duration,
        uint256 maxRepayment,
        uint256[] calldata depths
    ) external returns (uint256);

    /**
     * @notice Liquidate an expired loan
     *
     * Emits a {LoanLiquidated} event.
     *
     * @param loanReceipt Loan receipt
     */
    function liquidate(bytes calldata loanReceipt) external;

    /**************************************************************************/
    /* Callbacks */
    /**************************************************************************/

    /**
     * @notice Callback on loan collateral liquidated
     * @param loanReceipt Loan receipt
     * @param proceeds Liquidation proceeds in currency tokens
     */
    function onCollateralLiquidated(bytes calldata loanReceipt, uint256 proceeds) external;

    /**************************************************************************/
    /* Deposit API */
    /**************************************************************************/

    /**
     * @notice Deposit amount at depth
     *
     * Emits a {Deposited} event.
     *
     * @param depth Loan limit depth
     * @param amount Amount of currency tokens
     */
    function deposit(uint256 depth, uint256 amount) external;

    /**
     * @notice Redeem deposit shares for currency tokens. Currency tokens can
     * be withdrawn with the `withdraw()` method once the redemption is
     * processed.
     *
     * Emits a {Redeemed} event.
     *
     * @param depth Loan limit depth
     * @param shares Amount of deposit shares to redeem
     */
    function redeem(uint256 depth, uint256 shares) external;

    /**
     * @notice Get redemption available
     *
     * @param account Account
     * @param depth Loan limit depth
     * @return shares Amount of deposit shares redeemed
     * @return amount Amount of currency tokens available for withdrawal
     */
    function redemptionAvailable(address account, uint256 depth) external view returns (uint256 shares, uint256 amount);

    /**
     * @notice Withdraw a redemption that is available
     *
     * Emits a {Withdrawn} event.
     *
     * @param depth Loan limit depth
     * @return amount Amount of currency tokens withdrawn
     */
    function withdraw(uint256 depth) external returns (uint256 amount);
}
