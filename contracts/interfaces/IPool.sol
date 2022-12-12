// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "./ICollateralFilter.sol";
import "./IInterestRateModel.sol";
import "./ILiquidationStrategy.sol";
import "./INoteAdapter.sol";
import "./ILendAdapter.sol";

/**
 * @title Interface to a Pool
 */
interface IPool {
    /**************************************************************************/
    /* Events */
    /**************************************************************************/

    /**
     * @notice Emitted when currency is deposited
     * @param account Depositing account
     * @param depositId Deposit ID
     * @param amount Amount of currency tokens
     * @param shares Amount of shares allocated
     */
    event Deposited(
        address indexed account,
        uint256 indexed depositId,
        uint256 amount,
        uint256 shares
    );

    /**
     * @notice Emitted when deposit shares are redeemed
     * @param account Redeeming account
     * @param depositId Deposit ID
     * @param shares Amount of shares redeemed
     * @param amount Amount of currency tokens
     */
    event Redeemed(
        address indexed account,
        uint256 indexed depositId,
        uint256 shares,
        uint256 amount
    );

    /**
     * @notice Emitted when redeemed currency tokens are withdrawn
     * @param account Withdrawing account
     * @param depositId Deposit ID
     * @param amount Amount of currency tokens withdrawn
     */
    event Withdrawn(
        address indexed account,
        uint256 indexed depositId,
        uint256 amount
    );

    /**
     * @notice Emitted when a loan is purchased
     * @param loanId Loan ID
     * @param loanReceipt Loan receipt
     */
    event LoanPurchased(uint256 indexed loanId, bytes loanReceipt);

    /**
     * @notice Emitted when a loan is originated
     * @param loanId Loan ID
     * @param loanReceipt Loan receipt
     */
    event LoanOriginated(uint256 indexed loanId, bytes loanReceipt);

    /**
     * @notice Emitted when a loan is repaid
     * @param loanId Loan ID
     */
    event LoanRepaid(uint256 indexed loanId);

    /**
     * @notice Emitted when a loan is liquidated
     * @param loanId Loan ID
     */
    event LoanLiquidated(uint256 indexed loanId);

    /**
     * @notice Emitted when loan collateral is liquidated
     * @param loanId Loan ID
     * @param proceeds Liquidation proceeds in currency tokens
     */
    event CollateralLiquidated(uint256 indexed loanId, uint256 proceeds);

    /**************************************************************************/
    /* Getters */
    /**************************************************************************/

    /**
     * @notice Get currency token
     * @return Currency token contract
     */
    function currencyToken() external view returns (address);

    /**
     * @notice Get collateral token
     * @return Collateral token address
     */
    function collateralToken() external view returns (address);

    /**
     * @notice Get maximum loan duration
     * @return Maximum loan duration in seconds
     */
    function duration() external view returns (uint64);

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
     * @notice Get note adapter contract
     * @param noteToken Note token contract
     * @return Note adapter contract
     */
    function noteAdapters(
        address noteToken
    ) external view returns (INoteAdapter);

    /**
     * @notice Get list of supported note tokens
     * @return Note token addresses
     */
    function supportedNoteTokens() external view returns (address[] memory);

    /**
     * @notice Get lend adapter contract
     * @param lendPlatform Lend platform contract
     * @return Lend adapter contract
     */
    function lendAdapters(
        address lendPlatform
    ) external view returns (ILendAdapter);

    /**
     * @notice Get list of supported lend platforms
     * @return Lend platform addresses
     */
    function supportedLendPlatforms() external view returns (address[] memory);

    /**************************************************************************/
    /* Note API */
    /**************************************************************************/

    /**
     * @notice Price a note
     *
     * @param noteToken Note token contract
     * @param noteTokenId Note token ID
     * @param collateralTokenIdSpec Collateral token ID specification
     * @return purchasePrice Purchase price in currency tokens
     */
    function priceNote(
        address noteToken,
        uint256 noteTokenId,
        bytes calldata collateralTokenIdSpec
    ) external view returns (uint256 purchasePrice);

    /**
     * @notice Sell a note
     *
     * Emits a {LoanPurchased} event.
     *
     * @param noteToken Note token contract
     * @param noteTokenId Note token ID
     * @param minPurchasePrice Minimum purchase price in currency tokens
     * @param collateralTokenIdSpec Collateral token ID specification
     * @return purchasePrice Executed purchase price in currency tokens
     */
    function sellNote(
        address noteToken,
        uint256 noteTokenId,
        uint256 minPurchasePrice,
        bytes calldata collateralTokenIdSpec
    ) external returns (uint256 purchasePrice);

    /**************************************************************************/
    /* Lend API */
    /**************************************************************************/

    /**
     * @notice Price a loan
     *
     * @param principal Principal amount in currency tokens
     * @param duration Duration in seconds
     * @param collateralTokenId Collateral token ID
     * @param collateralTokenIdSpec Collateral token ID specification
     * @return repayment Repayment amount in currency tokens
     */
    function priceLoan(
        uint256 principal,
        uint64 duration,
        uint256 collateralTokenId,
        bytes calldata collateralTokenIdSpec
    ) external view returns (uint256 repayment);

    /**
     * @notice Create a loan
     *
     * Emits a {LoanOriginated} event.
     *
     * @param principal Principal amount in currency tokens
     * @param duration Duration in seconds
     * @param collateralTokenId Collateral token ID
     * @param collateralTokenIdSpec Collateral token ID specification
     * @param maxRepayment Maximum repayment amount in currency tokens
     * @return loanId Loan ID
     */
    function createLoan(
        uint256 principal,
        uint256 duration,
        uint256 collateralTokenId,
        uint256 maxRepayment,
        bytes calldata collateralTokenIdSpec
    ) external returns (uint256 loanId);

    /**************************************************************************/
    /* Loan Callbacks */
    /**************************************************************************/

    /**
     * @notice Callback on loan repaid
     * @param loanReceipt Loan receipt
     */
    function onLoanRepaid(bytes calldata loanReceipt) external;

    /**
     * @notice Callback on loan expired
     * @param loanReceipt Loan receipt
     */
    function onLoanExpired(bytes calldata loanReceipt) external;

    /**
     * @notice Callback on loan collateral liquidated
     * @param loanReceipt Loan receipt
     */
    function onCollateralLiquidated(bytes calldata loanReceipt) external;

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
     * @return depositId Deposit ID
     */
    function deposit(
        uint256 depth,
        uint256 amount
    ) external returns (uint256 depositId);

    /**
     * @notice Deposit additional amount at depth
     *
     * Emits a {Deposited} event.
     *
     * @param depositId Deposit ID
     * @param amount Amount of currency tokens
     */
    function depositAdditional(uint256 depostId, uint256 amount) external;

    /**
     * @notice Redeem deposit for currency tokens. Currency tokens can be
     * withdrawn with the `withdraw()` method, once the redemption is
     * processed.
     *
     * Emits a {Redeemed} event.
     *
     * @param depositId Deposit ID
     * @param shares Amount of deposit shares
     * @return amount Amount of currency tokens
     */
    function redeem(
        uint256 depositId,
        uint256 shares
    ) external returns (uint256 amount);

    /**
     * @notice Get amount available for withdrawal
     *
     * @param depositId Deposit ID
     * @return amount Amount of currency tokens available for withdrawal
     */
    function withdrawalAvailable(
        uint256 depositId
    ) external view returns (uint256 amount);

    /**
     * @notice Withdraw redeemed currency tokens
     *
     * Emits a {Withdrawn} event.
     *
     * @param depositId Deposit ID
     * @param maxAmount Maximum amount of currency tokens to withdraw
     * @return amount Amount of currency tokens withdrawn
     */
    function withdraw(
        uint256 depositId,
        uint256 maxAmount
    ) external returns (uint256 amount);
}
