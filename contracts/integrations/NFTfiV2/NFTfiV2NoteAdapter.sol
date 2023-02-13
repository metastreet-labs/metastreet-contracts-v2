// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import "contracts/interfaces/INoteAdapter.sol";

/**************************************************************************/
/* NFTfiV2 Interfaces (derived and/or subset */
/**************************************************************************/

/*  IDirectLoanBase */
interface IDirectLoan {
    function loanIdToLoan(
        uint32
    )
        external
        view
        returns (
            uint256 /* loanPrincipalAmount */,
            uint256 /* maximumRepaymentAmount */,
            uint256 /* nftCollateralId */,
            address /* loanERC20Denomination */,
            uint32 /* loanDuration */,
            uint16 /* loanInterestRateForDurationInBasisPoints */,
            uint16 /* loanAdminFeeInBasisPoints */,
            address /* nftCollateralWrapper */,
            uint64 /* loanStartTime */,
            address /* nftCollateralContract */,
            address /* borrower */
        );
}

interface IDirectLoanCoordinator {
    enum StatusType {
        NOT_EXISTS,
        NEW,
        RESOLVED
    }

    struct Loan {
        address loanContract;
        uint64 smartNftId;
        StatusType status;
    }

    function promissoryNoteToken() external view returns (address);

    function getLoanData(uint32 _loanId) external view returns (Loan memory);
}

/* derived interface */
interface ISmartNft {
    /* public state variable in SmartNft */
    function loans(uint256 _tokenId) external view returns (address /* loanCoordinator */, uint256 /* loanId */);
}

/**************************************************************************/
/* Note Adapter Implementation */
/**************************************************************************/

/**
 * @title NFTfiV2 Note Adapter
 */
contract NFTfiV2NoteAdapter is INoteAdapter {
    /**************************************************************************/
    /* Constants */
    /**************************************************************************/

    /**
     * @notice Implementation version
     */
    string public constant IMPLEMENTATION_VERSION = "1.0";

    /**
     * @notice Supported loan type
     */
    bytes32 public constant SUPPORTED_LOAN_TYPE1 = bytes32("DIRECT_LOAN_FIXED_REDEPLOY");
    bytes32 public constant SUPPORTED_LOAN_TYPE2 = bytes32("DIRECT_LOAN_FIXED_COLLECTION");

    /**
     * @notice Basis points denominator used for calculating repayment
     */
    uint256 public constant BASIS_POINTS_DENOMINATOR = 10_000;

    /**************************************************************************/
    /* Properties */
    /**************************************************************************/

    IDirectLoanCoordinator private immutable _directLoanCoordinator;
    ISmartNft private immutable _noteToken;

    /**************************************************************************/
    /* Constructor */
    /**************************************************************************/

    /**
     * @notice NFTfiV2NoteAdapter constructor
     * @param directLoanCoordinator Direct loan coordinator contract
     */
    constructor(IDirectLoanCoordinator directLoanCoordinator) {
        _directLoanCoordinator = directLoanCoordinator;
        _noteToken = ISmartNft(directLoanCoordinator.promissoryNoteToken());
    }

    /**************************************************************************/
    /* Implementation */
    /**************************************************************************/

    /**
     * @inheritdoc ILoanAdapter
     */
    function name() external pure returns (string memory) {
        return "NFTfi v2 Note Adapter";
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
        /* Lookup loan coordinator and loan id */
        (, uint256 loanId) = _noteToken.loans(noteTokenId);

        return loanId;
    }

    /**
     * @inheritdoc ILoanAdapter
     */
    function getLoanInfo(uint256 loanId, bytes memory) external view returns (LoanInfo memory) {
        /* Lookup loan data */
        IDirectLoanCoordinator.Loan memory loanData = _directLoanCoordinator.getLoanData(uint32(loanId));

        /* Get loan contract */
        IDirectLoan loanContract = IDirectLoan(loanData.loanContract);

        /* Lookup loan terms */
        (
            uint256 loanPrincipalAmount,
            uint256 maximumRepaymentAmount,
            uint256 nftCollateralId,
            address loanERC20Denomination,
            uint32 loanDuration,
            ,
            uint16 loanAdminFeeInBasisPoints,
            ,
            uint64 loanStartTime,
            address nftCollateralContract,
            address borrower
        ) = loanContract.loanIdToLoan(uint32(loanId));

        /* Populate assets */
        AssetInfo[] memory assets = new AssetInfo[](1);
        assets[0] = AssetInfo({assetType: AssetType.ERC721, token: nftCollateralContract, tokenId: nftCollateralId});

        /* Calculate admin fee */
        uint256 adminFee = ((maximumRepaymentAmount - loanPrincipalAmount) * uint256(loanAdminFeeInBasisPoints)) /
            BASIS_POINTS_DENOMINATOR;

        /* Arrange into LoanInfo structure */
        LoanInfo memory loanInfo = LoanInfo({
            loanId: loanId,
            borrower: borrower,
            principal: loanPrincipalAmount,
            repayment: maximumRepaymentAmount - adminFee,
            maturity: loanStartTime + loanDuration,
            duration: loanDuration,
            currencyToken: loanERC20Denomination,
            collateralToken: nftCollateralContract,
            collateralTokenId: nftCollateralId,
            assets: assets
        });

        return loanInfo;
    }

    /**
     * @inheritdoc ILoanAdapter
     */
    function getLoanStatus(uint256 loanId, bytes memory) external view returns (LoanStatus) {
        /* Lookup loan data */
        IDirectLoanCoordinator.Loan memory loanData = _directLoanCoordinator.getLoanData(uint32(loanId));

        /* Return unknown if no loan data associated with loanId */
        if (loanData.loanContract == address(0)) return LoanStatus.Unknown;

        /* Lookup loan terms */
        (, , , , uint32 loanDuration, , , , uint64 loanStartTime, , ) = IDirectLoan(loanData.loanContract).loanIdToLoan(
            uint32(loanId)
        );

        /* Cannot differentiate between repaid and liquidated */
        if (loanData.status == IDirectLoanCoordinator.StatusType.RESOLVED) return LoanStatus.Repaid;

        /* Expired */
        if (loanData.status == IDirectLoanCoordinator.StatusType.NEW && block.timestamp > loanStartTime + loanDuration)
            return LoanStatus.Expired;

        /* Active */
        if (loanData.status == IDirectLoanCoordinator.StatusType.NEW) return LoanStatus.Active;

        return LoanStatus.Unknown;
    }

    /**
     * @inheritdoc ILoanAdapter
     */
    function getLiquidateCalldata(uint256 loanId, bytes memory) external view returns (address, bytes memory) {
        /* Lookup loan data for loan contract */
        IDirectLoanCoordinator.Loan memory loanData = _directLoanCoordinator.getLoanData(uint32(loanId));

        return (loanData.loanContract, abi.encodeWithSignature("liquidateOverdueLoan(uint32)", uint32(loanId)));
    }
}
