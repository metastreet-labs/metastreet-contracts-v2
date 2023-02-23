// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.15;

import "contracts/interfaces/INoteAdapter.sol";
import "./IPurchaseEscrow.sol";

/**
 * @title Purchase Escrow V2 Note Adapter
 */
contract PurchaseEscrowV2NoteAdapter is INoteAdapter {
    /**************************************************************************/
    /* Constants */
    /**************************************************************************/

    /**
     * @notice Implementation version
     */
    string public constant IMPLEMENTATION_VERSION = "2.0";

    /**************************************************************************/
    /* Properties */
    /**************************************************************************/

    IPurchaseEscrow private immutable _purchaseEscrowPlatform;

    /**************************************************************************/
    /* Constructor */
    /**************************************************************************/

    /**
     * @notice PurchaseEscrowNoteAdapter constructor
     * @param purchaseEscrowPlatform Purchase escrow platform contract
     */
    constructor(IPurchaseEscrow purchaseEscrowPlatform) {
        _purchaseEscrowPlatform = purchaseEscrowPlatform;
    }

    /**************************************************************************/
    /* Implementation */
    /**************************************************************************/

    /**
     * @inheritdoc ILoadAdapter
     */
    function name() external pure returns (string memory) {
        return "Purchase Escrow Lender Note Adapter";
    }

    /**
     * @inheritdoc ILoanAdapter
     */
    function getAdapterType() external pure returns (AdapterType) {
        return AdapterType.Note;
    }

    /**
     * @inheritdoc INoteAdapter
     */
    function getLoanId(uint256 noteTokenId) external pure returns (uint256) {
        return noteTokenId;
    }

    /**
     * @inheritdoc INoteAdapter
     */
    function getLoanInfo(uint256 noteTokenId, bytes memory) external view returns (LoanInfo memory) {
        /* Get purchase escrow terms from purchase escrow platform */
        IPurchaseEscrow.PurchaseEscrowTerms memory terms = _purchaseEscrowPlatform.purchaseEscrows(noteTokenId);

        /* Populate assets */
        AssetInfo[] memory assets = new AssetInfo[](1);
        assets[0] = AssetInfo({assetType: AssetType.ERC721, token: address(terms.token), tokenId: terms.tokenId});

        /* Arrange into LoanInfo structure */
        LoanInfo memory loanInfo = LoanInfo({
            loanId: noteTokenId,
            borrower: terms.buyer,
            principal: terms.principal,
            repayment: terms.repayment,
            maturity: terms.startTime + terms.duration,
            duration: terms.duration,
            currencyToken: address(_purchaseEscrowPlatform.currencyToken()),
            collateralToken: address(terms.token),
            collateralTokenId: terms.tokenId,
            assets: assets
        });

        return loanInfo;
    }

    /**
     * @inheritdoc ILoanAdapter
     */
    function getLoanStatus(uint256 loanId, bytes memory) external view returns (LoanStatus) {
        /* Get purchase escrow terms from purchase escrow platform */
        IPurchaseEscrow.PurchaseEscrowTerms memory terms = _purchaseEscrowPlatform.purchaseEscrows(loanId);

        /* Liquidated */
        if (terms.status == IPurchaseEscrow.PurchaseEscrowStatus.Liquidated) return LoanStatus.Liquidated;

        /* Repaid */
        if (terms.status == IPurchaseEscrow.PurchaseEscrowStatus.Repaid) return LoanStatus.Repaid;

        /* Expired */
        if (block.timestamp > terms.startTime + terms.duration) return LoanStatus.Expired;

        /* Active */
        if (terms.status == IPurchaseEscrow.PurchaseEscrowStatus.Active) return LoanStatus.Active;

        return LoanStatus.Unknown;
    }

    /**
     * @inheritdoc ILoanAdapter
     */
    function getLiquidateCalldata(uint256 loanId, bytes memory) external view returns (address, bytes memory) {
        return (address(_purchaseEscrowPlatform), abi.encodeWithSignature("liquidate(uint256)", loanId));
    }
}
