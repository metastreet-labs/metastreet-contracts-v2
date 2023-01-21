// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.17;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC721/utils/ERC721Holder.sol";
import "@openzeppelin/contracts/utils/introspection/ERC165.sol";
import "@openzeppelin/contracts/utils/introspection/ERC165Checker.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import "./TestNoteToken.sol";
import "./TestBundleToken.sol";

/**
 * @title Test Lending Platform
 */
contract TestLendingPlatform is Ownable, ERC721Holder, ERC165 {
    using SafeERC20 for IERC20;

    /**************************************************************************/
    /* Errors */
    /**************************************************************************/

    /**
     * @notice Invalid caller
     */
    error InvalidCaller();

    /**
     * @notice Invalid parameters
     */
    error InvalidParameters();

    /**
     * @notice Invalid loan status
     */
    error InvalidLoanStatus();

    /**
     * @notice Loan not expired
     */
    error LoanNotExpired();

    /**************************************************************************/
    /* Events */
    /**************************************************************************/

    /**
     * @notice Emitted when a loan is created
     * @param loanId Loan ID
     * @param borrower Borrower
     * @param lender Lender
     */
    event LoanCreated(uint256 loanId, address borrower, address lender);

    /**
     * @notice Emitted when a loan is repaid
     * @param loanId Loan ID
     */
    event LoanRepaid(uint256 loanId);

    /**
     * @notice Emitted when a loan is liquidated
     * @param loanId Loan ID
     */
    event LoanLiquidated(uint256 loanId);

    /**************************************************************************/
    /* Structures */
    /**************************************************************************/

    /**
     * @notice Loan status
     */
    enum LoanStatus {
        Unknown,
        Active,
        Repaid,
        Liquidated
    }

    /**
     * @notice Loan terms
     * @param status Loan status
     * @param borrower Borrower
     * @param principal Principal amount
     * @param repayment Repayment amount
     * @param startTime Start timestamp
     * @param duration Duration in seconds
     * @param collateralToken Collateral token
     * @param collateralTokenId Collateral token ID
     */
    struct LoanTerms {
        LoanStatus status;
        address borrower;
        uint256 principal;
        uint256 repayment;
        uint64 startTime;
        uint32 duration;
        address collateralToken;
        uint256 collateralTokenId;
    }

    /**************************************************************************/
    /* Properties and State */
    /**************************************************************************/

    /**
     * @dev Currency token
     */
    IERC20 public immutable currencyToken;

    /**
     * @dev Promissory note token
     */
    TestNoteToken public immutable noteToken;

    /**
     * @dev Bundle token
     */
    TestBundleToken public immutable bundleToken;

    /**
     * @dev Mapping of loan ID to loan terms
     */
    mapping(uint256 => LoanTerms) private _loans;

    /**
     * @dev Loan ID counter
     */
    uint256 private _loanId;

    /**************************************************************************/
    /* Constructor */
    /**************************************************************************/

    /**
     * @notice TestLendingPlatform constructor
     * @param currencyToken_ Currency token
     */
    constructor(IERC20 currencyToken_) {
        currencyToken = currencyToken_;
        noteToken = new TestNoteToken();
        bundleToken = new TestBundleToken();
    }

    /**************************************************************************/
    /* Getter */
    /**************************************************************************/

    function loans(uint256 loanId) external view returns (LoanTerms memory) {
        return _loans[loanId];
    }

    /**************************************************************************/
    /* Primary API */
    /**************************************************************************/

    /**
     * @notice Create a new loan
     *
     * Emits a {LoanCreated} event.
     *
     * @param borrower Borrower address
     * @param collateralToken Collateral token contract
     * @param collateralTokenId Collateral token ID
     * @param principal Principal amount
     * @param repayment Repayment amount
     * @param duration Duration in seconds
     */
    function lend(
        address borrower,
        IERC721 collateralToken,
        uint256 collateralTokenId,
        uint256 principal,
        uint256 repayment,
        uint32 duration
    ) public {
        if (repayment < principal) revert InvalidParameters();

        uint256 loanId = _loanId++;

        LoanTerms storage loan = _loans[loanId];
        loan.status = LoanStatus.Active;
        loan.borrower = borrower;
        loan.principal = principal;
        loan.repayment = repayment;
        loan.startTime = uint64(block.timestamp);
        loan.duration = duration;
        loan.collateralToken = address(collateralToken);
        loan.collateralTokenId = collateralTokenId;

        collateralToken.safeTransferFrom(borrower, address(this), collateralTokenId);
        currencyToken.safeTransferFrom(msg.sender, borrower, principal);
        noteToken.mint(msg.sender, loanId);

        emit LoanCreated(loanId, borrower, msg.sender);
    }

    /**
     * @notice Repay a loan
     *
     * Emits a {LoanRepaid} event.
     *
     * @param loanId Loan ID
     */
    function repay(uint256 loanId) external {
        LoanTerms storage loan = _loans[loanId];

        if (loan.status != LoanStatus.Active) revert InvalidLoanStatus();
        if (msg.sender != loan.borrower) revert InvalidCaller();

        loan.status = LoanStatus.Repaid;

        address noteOwner = noteToken.ownerOf(loanId);

        currencyToken.safeTransferFrom(loan.borrower, noteOwner, loan.repayment);
        IERC721(loan.collateralToken).safeTransferFrom(address(this), loan.borrower, loan.collateralTokenId);
        noteToken.burn(loanId);

        emit LoanRepaid(loanId);
    }

    /**
     * @notice Liquidate a loan
     *
     * Emits a {LoanLiquidated} event.
     *
     * @param loanId Loan ID
     */
    function liquidate(uint256 loanId) external {
        LoanTerms storage loan = _loans[loanId];

        if (loan.status != LoanStatus.Active) revert InvalidLoanStatus();
        if (block.timestamp < loan.startTime + loan.duration) revert LoanNotExpired();
        if (msg.sender != noteToken.ownerOf(loanId)) revert InvalidCaller();

        loan.status = LoanStatus.Liquidated;

        IERC721(loan.collateralToken).safeTransferFrom(
            address(this),
            noteToken.ownerOf(loanId),
            loan.collateralTokenId
        );
        noteToken.burn(loanId);

        emit LoanLiquidated(loanId);
    }

    /******************************************************/
    /* ERC165 interface */
    /******************************************************/

    /**
     * @inheritdoc IERC165
     */
    function supportsInterface(bytes4 interfaceId) public view override returns (bool) {
        return interfaceId == type(IERC721Receiver).interfaceId || super.supportsInterface(interfaceId);
    }
}
