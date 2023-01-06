// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/**
 * @title Interface to a loan
 */
interface ILoan {
    /**************************************************************************/
    /* Enums */
    /**************************************************************************/

    /**
     * @notice Asset type
     */
    enum AssetType {
        ERC721
    }

    /**
     * @notice Loan status
     */
    enum LoanStatus {
        Uninitialized,
        Active,
        Repaid,
        Expired,
        Liquidated
    }

    /**************************************************************************/
    /* Structures */
    /**************************************************************************/

    /**
     * @notice Asset information
     * @param assetType Asset type
     * @param token Token contract
     * @param tokenId Token ID
     */
    struct AssetInfo {
        AssetType assetType;
        address token;
        uint256 tokenId;
    }

    /**
     * @notice Loan information
     * @param loanId Loan ID
     * @param borrower Borrower
     * @param principal Principal value
     * @param repayment Repayment value
     * @param maturity Maturity in seconds since Unix epoch
     * @param duration Duration in seconds
     * @param currencyToken Currency token used by loan
     * @param collateralToken Collateral token contract
     * @param collateralTokenId Collateral token ID
     * @param assets Collateral assets
     */
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

    /**************************************************************************/
    /* API */
    /**************************************************************************/

    /**
     * Get loan information
     * @param loanId Loan ID
     * @param loanReceipt Loan receipt
     * @return Loan information
     */
    function getLoanInfo(uint256 loanId, bytes memory loanReceipt) external view returns (LoanInfo memory);

    /**
     * Get loan status
     * @param loanId Loan ID
     * @param loanReceipt Loan receipt
     * @return Loan status
     */
    function getLoanStatus(uint256 loanId, bytes memory loanReceipt) external view returns (LoanStatus);

    /**
     * Get liquidation calldata
     * @param loanId Loan ID
     * @param loanReceipt Loan receipt
     * @return Target address
     * @return Encoded calldata with selector
     */
    function getLiquidateCalldata(
        uint256 loanId,
        bytes memory loanReceipt
    ) external view returns (address, bytes memory);
}
