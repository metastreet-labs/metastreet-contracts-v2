// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "./ILoan.sol";

/**
 * @title Interface to a Lend Adapter
 */
interface ILendAdapter is ILoan {
    /**
     * Get lend adapter name
     * @return Lend adapter name
     */
    function name() external view returns (string memory);

    /**
     * Create a loan
     * @param borrower Borrower
     * @param principal Principal amount
     * @param repayment Repayment amount
     * @param duration Duration in seconds
     * @param currencyToken Currency token address
     * @param collateralToken Collateral token address
     * @param collateralTokenId Collateral token ID
     * @return Loan info
     */
    function createLoan(
        address borrower,
        uint256 principal,
        uint256 repayment,
        uint256 duration,
        address currencyToken,
        address collateralToken,
        uint256 collateralTokenId
    ) external view returns (LoanInfo memory);
}
