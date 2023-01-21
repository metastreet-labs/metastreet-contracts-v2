// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.17;

import "contracts/interfaces/INoteAdapter.sol";

import "./TestLendingPlatform.sol";

/**
 * @title Test Note Adapter
 */
contract TestNoteAdapter is INoteAdapter {
    /**************************************************************************/
    /* Constants */
    /**************************************************************************/

    /**
     * @notice Implementation version
     */
    string public constant IMPLEMENTATION_VERSION = "1.0";

    /**************************************************************************/
    /* Properties */
    /**************************************************************************/

    TestLendingPlatform private immutable _lendingPlatform;

    /**************************************************************************/
    /* Constructor */
    /**************************************************************************/

    /**
     * @notice TestNoteAdapter constructor
     * @param testLendingPlatform Test lending platform contract
     */
    constructor(TestLendingPlatform testLendingPlatform) {
        _lendingPlatform = testLendingPlatform;
    }

    /**************************************************************************/
    /* Note Adapter Implementation */
    /**************************************************************************/

    /**
     * @inheritdoc INoteAdapter
     */
    function getLoanId(uint256 noteTokenId) external pure returns (uint256) {
        return noteTokenId;
    }

    /**************************************************************************/
    /* Loan Adapter Implementation */
    /**************************************************************************/

    /**
     * @inheritdoc ILoanAdapter
     */
    function name() external pure returns (string memory) {
        return "TestNoteAdapter";
    }

    /**
     * @inheritdoc ILoanAdapter
     */
    function getAdapterType() external pure returns (AdapterType) {
        return AdapterType.Note;
    }

    /**
     * @inheritdoc ILoanAdapter
     */
    function getLoanInfo(uint256 loanId, bytes memory) external view returns (LoanInfo memory) {
        /* Get loan terms from lending platform */
        TestLendingPlatform.LoanTerms memory loanTerms = _lendingPlatform.loans(loanId);

        AssetInfo[] memory assets = new AssetInfo[](1);
        assets[0] = AssetInfo({
            assetType: AssetType.ERC721,
            token: loanTerms.collateralToken,
            tokenId: loanTerms.collateralTokenId
        });

        /* Arrange into LoanInfo structure */
        LoanInfo memory loanInfo = LoanInfo({
            loanId: loanId,
            borrower: loanTerms.borrower,
            principal: loanTerms.principal,
            repayment: loanTerms.repayment,
            maturity: loanTerms.startTime + loanTerms.duration,
            duration: loanTerms.duration,
            currencyToken: address(_lendingPlatform.currencyToken()),
            collateralToken: loanTerms.collateralToken,
            collateralTokenId: loanTerms.collateralTokenId,
            assets: assets
        });

        return loanInfo;
    }

    /**
     * @inheritdoc ILoanAdapter
     */
    function getLoanStatus(uint256 loanId, bytes memory) external view returns (LoanStatus) {
        /* Get loan terms from lending platform */
        TestLendingPlatform.LoanTerms memory loanTerms = _lendingPlatform.loans(loanId);

        /* Map loan term status */
        if (loanTerms.status == TestLendingPlatform.LoanStatus.Unknown) return LoanStatus.Unknown;
        if (loanTerms.status == TestLendingPlatform.LoanStatus.Repaid) return LoanStatus.Repaid;
        if (loanTerms.status == TestLendingPlatform.LoanStatus.Liquidated) return LoanStatus.Liquidated;
        if (block.timestamp > loanTerms.startTime + loanTerms.duration) return LoanStatus.Expired;
        return LoanStatus.Active;
    }

    /**
     * @inheritdoc ILoanAdapter
     */
    function getLiquidateCalldata(uint256 loanId, bytes memory) external view returns (address, bytes memory) {
        return (address(_lendingPlatform), abi.encodeWithSignature("liquidate(uint256)", loanId));
    }
}
