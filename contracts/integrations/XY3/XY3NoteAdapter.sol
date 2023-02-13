// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import "@openzeppelin/contracts/token/ERC721/IERC721.sol";

import "contracts/interfaces/INoteAdapter.sol";

/**************************************************************************/
/* XY3 Interfaces (derived and/or subset) */
/**************************************************************************/

/* derived interface */
interface IXY3 {
    /* ILoanStatus */
    enum StatusType {
        NOT_EXISTS,
        NEW,
        RESOLVED
    }

    /* ILoanStatus */
    struct LoanState {
        uint64 xy3NftId;
        StatusType status;
    }

    /* IXY3 */
    function loanDetails(
        uint32
    )
        external
        view
        returns (
            uint256 /* borrowAmount */,
            uint256 /* repayAmount */,
            uint256 /* nftTokenId */,
            address /* borrowAsset */,
            uint32 /* loanDuration */,
            uint16 /* adminShare */,
            uint64 /* loanStart */,
            address /* nftAsset */,
            bool /* isCollection */
        );

    /* ILoanStatus */
    function getLoanState(uint32 _loanId) external view returns (LoanState memory);

    /* IConfig */
    function getAddressProvider() external view returns (IAddressProvider);

    /* public state variable in LoanStatus */
    function totalNumLoans() external view returns (uint32);
}

/* derived interface */
interface IXY3Nft is IERC721 {
    /* Xy3Nft */
    struct Ticket {
        uint256 loanId;
        address minter /* xy3 address */;
    }

    /* public state variable in Xy3Nft */
    function tickets(uint256 _tokenId) external view returns (Ticket memory);
}

interface IAddressProvider {
    function getBorrowerNote() external view returns (address);

    function getLenderNote() external view returns (address);
}

/**************************************************************************/
/* Note Adapter Implementation */
/**************************************************************************/

/**
 * @title X2Y2 V2 Note Adapter
 */
contract XY3NoteAdapter is INoteAdapter {
    /**************************************************************************/
    /* Constants */
    /**************************************************************************/

    /**
     * @notice Implementation version
     */
    string public constant IMPLEMENTATION_VERSION = "1.0";

    /**
     * @notice Basis points denominator used for calculating repayment
     */
    uint256 public constant BASIS_POINTS_DENOMINATOR = 10_000;

    /**************************************************************************/
    /* Properties */
    /**************************************************************************/

    IXY3 private immutable _xy3;
    IXY3Nft private immutable _lenderNote;
    IXY3Nft private immutable _borrowerNote;

    /**************************************************************************/
    /* Constructor */
    /**************************************************************************/

    constructor(IXY3 xY3) {
        _xy3 = xY3;
        _lenderNote = IXY3Nft(_xy3.getAddressProvider().getLenderNote());
        _borrowerNote = IXY3Nft(_xy3.getAddressProvider().getBorrowerNote());
    }

    /**************************************************************************/
    /* Implementation */
    /**************************************************************************/

    /**
     * @inheritdoc ILoanAdapter
     */
    function name() external pure returns (string memory) {
        return "XY3 Note Adapter";
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
    function getLoanId(uint256 noteTokenId) external view returns (uint256) {
        return _lenderNote.tickets(noteTokenId).loanId;
    }

    /**
     * @inheritdoc ILoanAdapter
     */
    function getLoanInfo(uint256 loanId, bytes memory) external view returns (LoanInfo memory) {
        /* Lookup loan data */
        (
            uint256 borrowAmount,
            uint256 repayAmount,
            uint256 nftTokenId,
            address borrowAsset,
            uint32 loanDuration,
            uint16 adminShare,
            uint64 loanStart,
            address nftAsset,

        ) = _xy3.loanDetails(uint32(loanId));

        /* Populate assets */
        AssetInfo[] memory assets = new AssetInfo[](1);
        assets[0] = AssetInfo({assetType: AssetType.ERC721, token: nftAsset, tokenId: nftTokenId});

        /* lookup tokenId */
        uint64 xy3NftId = _xy3.getLoanState(uint32(loanId)).xy3NftId;

        /* Lookup borrower */
        address borrower = _borrowerNote.ownerOf(xy3NftId);

        /* Calculate admin fee */
        uint256 adminFee = ((repayAmount - borrowAmount) * uint256(adminShare)) / BASIS_POINTS_DENOMINATOR;

        /* Arrange into LoanInfo structure */
        LoanInfo memory loanInfo = LoanInfo({
            loanId: loanId,
            borrower: borrower,
            principal: borrowAmount,
            repayment: repayAmount - adminFee,
            maturity: loanStart + loanDuration,
            duration: loanDuration,
            currencyToken: borrowAsset,
            collateralToken: nftAsset,
            collateralTokenId: nftTokenId,
            assets: assets
        });

        return loanInfo;
    }

    /**
     * @inheritdoc ILoanAdapter
     */
    function getLoanStatus(uint256 loanId, bytes memory) external view returns (LoanStatus) {
        /* Lookup loan terms */
        (, , , , uint32 loanDuration, , uint64 loanStart, , ) = _xy3.loanDetails(uint32(loanId));

        /* Lookup loan state */
        IXY3.LoanState memory loanState = _xy3.getLoanState(uint32(loanId));

        /* Cannot differentiate between repaid and liquidated */
        if (loanId > 10_000 && loanId <= _xy3.totalNumLoans() && loanState.xy3NftId == 0) return LoanStatus.Repaid;

        /* Expired */
        if (loanState.status == IXY3.StatusType.NEW && block.timestamp > loanStart + loanDuration)
            return LoanStatus.Expired;

        /* Active */
        if (loanState.status == IXY3.StatusType.NEW) return LoanStatus.Active;

        return LoanStatus.Unknown;
    }

    /**
     * @inheritdoc ILoanAdapter
     */
    function getLiquidateCalldata(uint256 loanId, bytes memory) external view returns (address, bytes memory) {
        return (address(_xy3), abi.encodeWithSignature("liquidate(uint32)", uint32(loanId)));
    }
}
