// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/**
 * @title Interface to a loan
 */
interface ILoan {
    enum AssetType {
        ERC721
    }

    enum LoanStatus {
        Repaid,
        Expired,
        Liquidated
    }

    struct AssetInfo {
        AssetType assetType;
        address token;
        uint256 tokenId;
    }

    struct LoanInfo {
        uint256 loanId;
        address borrower;
        uint256 principal;
        uint256 repayment;
        uint64 maturity;
        uint64 duration;
        address currencyToken;
        address collateralToken;
        uint256 collateralTokenId;
        AssetInfo[] assets;
    }

    function getLoanInfo(
        uint256 loanId,
        bytes memory loanReceipt
    ) external view returns (LoanInfo memory);

    function getLoanStatus(
        uint256 loanId,
        bytes memory loanReceipt
    ) external view returns (LoanStatus);

    function getLiquidateCalldata(
        uint256 loanId,
        bytes memory loanReceipt
    ) external view returns (address target, bytes memory calldata);
}
