// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "./ICollateralFilter.sol";
import "./IInterestRateModel.sol";
import "./ILiquidationStrategy.sol";
import "./INoteAdapter.sol";
import "./ILendAdapter.sol";

/**
 * @title Interface to a Vault
 */
interface IVault {
    event LoanOriginated(uint256 indexed loanId, bytes loanReceipt);
    event LoanPurchased(uint256 indexed loanId, bytes loanReceipt);
    event LoanRepaid(uint256 indexed loanId);
    event LoanLiquidated(uint256 indexed loanId);
    event CollateralLiquidated(uint256 indexed loanId, uint256 proceeds);

    event Deposited(
        address indexed account,
        uint256 indexed depositId,
        uint256 amount,
        uint256 shares
    );
    event Redeemed(
        address indexed account,
        uint256 indexed depositId,
        uint256 shares,
        uint256 amount
    );
    event Withdrawn(
        address indexed account,
        uint256 indexed depositId,
        uint256 amount
    );

    // constructor(address currencyToken, address collateralToken, uint64 maxDuration,
    //             ICollateralFilter collateralFilter, IInterestRateModel interestRateModel,
    //             ILiquidationStrategy liquidationStrategy)
    // TODO attaching and modifying note and lend adapters?

    /* Getters */
    function currencyToken() external view returns (address);

    function maxDuration() external view returns (uint256 duration);

    function collateralFilter() external view returns (ICollateralFilter);

    function interestRateModel() external view returns (IInterestRateModel);

    function liquidationStrategy() external view returns (ILiquidationStrategy);

    function collateralToken() external view returns (address);

    function collateralTokenIdSupported(
        uint256 tokenId,
        bytes calldata tokenIdSpec
    ) external view returns (bool);

    function noteAdapters(
        address noteToken
    ) external view returns (INoteAdapter);

    function supportedNoteTokens() external view returns (address[] memory);

    function lendAdapters(
        address lendPlatform
    ) external view returns (ILendAdapter);

    function supportedLendPlatforms() external view returns (address[] memory);

    /* Lend API */
    function priceLoan(
        uint256 principal,
        uint256 duration,
        address collateralToken,
        uint256 collateralTokenId,
        bytes calldata collateralTokenIdSpec
    ) external view returns (uint256 repayment);

    function createLoan(
        uint256 principal,
        uint256 duration,
        address collateralToken,
        uint256 collateralTokenId,
        uint256 maxRepayment,
        bytes calldata collateralTokenIdSpec
    ) external returns (uint256 loanId);

    /* Note API */
    function priceNote(
        address noteToken,
        uint256 noteTokenId,
        bytes calldata collateralTokenIdSpec
    ) external view returns (uint256 purchasePrice);

    function sellNote(
        address noteToken,
        uint256 noteTokenId,
        uint256 minPurchasePrice,
        bytes calldata collateralTokenIdSpec
    ) external returns (uint256 purchasePrice);

    /* Loan Callbacks */
    function onLoanRepaid(bytes calldata loanReceipt) external;

    function onLoanExpired(bytes calldata loanReceipt) external;

    function onCollateralLiquidated(bytes calldata loanReceipt) external;

    /* Deposit API */
    function deposit(
        uint256 depth,
        uint256 amount
    ) external returns (uint256 depositId);

    function depositAdditional(uint256 depostId, uint256 amount) external;

    function redeem(
        uint256 depositId,
        uint256 shares
    ) external returns (uint256 amount);

    function withdrawalAvailable(
        uint256 depositId
    ) external view returns (uint256 amount);

    function withdraw(
        uint256 depositId,
        uint256 maxAmount
    ) external returns (uint256 amount);
}
