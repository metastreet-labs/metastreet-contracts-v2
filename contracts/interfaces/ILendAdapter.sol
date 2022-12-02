// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "./ILoan.sol";

/**
 * @title Interface to a Lend Adapter
 */
interface ILendAdapter is ILoan {
    function name() external view returns (string memory);

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
