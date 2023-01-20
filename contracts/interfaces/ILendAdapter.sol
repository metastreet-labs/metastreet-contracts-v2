// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "./ILoanAdapter.sol";

/**
 * @title Interface to a Lend Adapter
 */
interface ILendAdapter is ILoanAdapter {
    /**
     * Get lend adapter name
     * @return Lend adapter name
     */
    function name() external view returns (string memory);

    /**
     * Originate a loan
     * @param borrower Borrower
     * @param principal Principal amount
     * @param repayment Repayment amount
     * @param duration Duration in seconds
     * @param currencyToken Currency token address
     * @param collateralToken Collateral token address
     * @param collateralTokenId Collateral token ID
     * @param collateralTokenIdSpec Collateral token ID specification
     * @return Loan info
     */
    function originateLoan(
        address borrower,
        uint256 principal,
        uint256 repayment,
        uint64 duration,
        address currencyToken,
        address collateralToken,
        uint256 collateralTokenId,
        bytes[] calldata collateralTokenIdSpec
    ) external view returns (LoanInfo memory);
}
