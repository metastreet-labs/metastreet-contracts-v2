// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

import "@openzeppelin/contracts/token/ERC721/IERC721.sol";

import "contracts/interfaces/INoteAdapter.sol";

import "./LoanLibrary.sol";
import "./IVaultFactory.sol";
import "./IVaultInventoryReporter.sol";

/**************************************************************************/
/* ArcadeV2 Interfaces (subset) */
/**************************************************************************/

interface ILoanCore {
    function getLoan(uint256 loanId) external view returns (LoanLibrary.LoanData calldata loanData);

    function borrowerNote() external returns (IERC721);

    function lenderNote() external returns (IERC721);
}

interface IVaultDepositRouter {
    function factory() external returns (address);

    function reporter() external returns (IVaultInventoryReporter);
}

interface IRepaymentController {
    function claim(uint256 loanId) external;
}

/**************************************************************************/
/* Note Adapter Implementation */
/**************************************************************************/

/**
 * @title ArcadeV2 Note Adapter
 */
contract ArcadeV2NoteAdapter is INoteAdapter {
    /**************************************************************************/
    /* Constants */
    /**************************************************************************/

    /**
     * @notice Implementation version
     */
    string public constant IMPLEMENTATION_VERSION = "1.0";

    /**
     * @notice Interest rate denominator used for calculating repayment
     */
    uint256 public constant INTEREST_RATE_DENOMINATOR = 1e18;

    /**
     * @notice Basis points denominator used for calculating repayment
     */
    uint256 public constant BASIS_POINTS_DENOMINATOR = 10_000;

    /**************************************************************************/
    /* Errors */
    /**************************************************************************/

    /**
     * @notice Unsupported collateral item
     */
    error UnsupportedCollateralItem();

    /**
     * @notice Unreported collateral inventory
     */
    error UnreportedCollateralInventory();

    /**************************************************************************/
    /* Properties */
    /**************************************************************************/

    ILoanCore private immutable _loanCore;
    IERC721 private immutable _borrowerNote;
    IERC721 private immutable _lenderNote;
    IRepaymentController private immutable _repaymentController;
    IVaultFactory private immutable _vaultFactory;
    IVaultInventoryReporter private immutable _vaultInventoryReporter;

    /**************************************************************************/
    /* Constructor */
    /**************************************************************************/

    /**
     * @notice ArcadeV2NoteAdapter constructor
     * @param loanCore Loan core contract
     */
    constructor(ILoanCore loanCore, IRepaymentController repaymentController, IVaultDepositRouter vaultDepositRouter) {
        _loanCore = loanCore;
        _borrowerNote = loanCore.borrowerNote();
        _lenderNote = loanCore.lenderNote();
        _repaymentController = repaymentController;
        _vaultFactory = IVaultFactory(vaultDepositRouter.factory());
        _vaultInventoryReporter = vaultDepositRouter.reporter();
    }

    /**************************************************************************/
    /* Implementation */
    /**************************************************************************/

    /**
     * @inheritdoc ILoanAdapter
     */
    function name() external pure returns (string memory) {
        return "Arcade v2 Note Adapter";
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
     * @inheritdoc ILoanAdapter
     */
    function getLoanInfo(uint256 loanId, bytes memory) external view returns (LoanInfo memory) {
        /* Lookup loan data */
        LoanLibrary.LoanData memory loanData = _loanCore.getLoan(loanId);

        /* Populate assets */
        AssetInfo[] memory assets;

        if (
            loanData.terms.collateralAddress == address(_vaultFactory) &&
            _vaultFactory.isInstance(address(uint160(loanData.terms.collateralId)))
        ) {
            /* Enumerate vault inventory */
            IVaultInventoryReporter.Item[] memory items = _vaultInventoryReporter.enumerateOrFail(
                address(uint160(loanData.terms.collateralId))
            );

            /* Check if vault inventory is empty */
            if (items.length == 0) revert UnreportedCollateralInventory();

            /* Translate vault inventory to asset infos */
            assets = new AssetInfo[](items.length);
            for (uint256 i; i < items.length; i++) {
                if (items[i].itemType != IVaultInventoryReporter.ItemType.ERC_721) revert UnsupportedCollateralItem();
                assets[i] = AssetInfo({
                    assetType: AssetType.ERC721,
                    token: items[i].tokenAddress,
                    tokenId: items[i].tokenId
                });
            }
        } else {
            assets = new AssetInfo[](1);
            assets[0].assetType = AssetType.ERC721;
            assets[0].token = loanData.terms.collateralAddress;
            assets[0].tokenId = loanData.terms.collateralId;
        }

        /* Calculate repayment */
        uint256 principal = loanData.terms.principal;
        uint256 repayment = principal +
            (principal * loanData.terms.interestRate) /
            INTEREST_RATE_DENOMINATOR /
            BASIS_POINTS_DENOMINATOR;

        /* Arrange into LoanInfo structure */
        LoanInfo memory loanInfo = LoanInfo({
            loanId: loanId,
            borrower: _borrowerNote.ownerOf(loanId),
            principal: principal,
            repayment: repayment,
            maturity: uint64(loanData.startDate + loanData.terms.durationSecs),
            duration: uint64(loanData.terms.durationSecs),
            currencyToken: loanData.terms.payableCurrency,
            collateralToken: loanData.terms.collateralAddress,
            collateralTokenId: loanData.terms.collateralId,
            assets: assets
        });

        return loanInfo;
    }

    /**
     * @inheritdoc ILoanAdapter
     */
    function getLoanStatus(uint256 loanId, bytes memory) external view returns (LoanStatus) {
        /* Lookup loan data */
        LoanLibrary.LoanData memory loanData = _loanCore.getLoan(loanId);

        /* Liquidated */
        if (loanData.state == LoanLibrary.LoanState.Defaulted) return LoanStatus.Liquidated;

        /* Repaid */
        if (loanData.state == LoanLibrary.LoanState.Repaid) return LoanStatus.Repaid;

        /* Expired */
        if (
            loanData.state == LoanLibrary.LoanState.Active &&
            block.timestamp > loanData.startDate + loanData.terms.durationSecs
        ) return LoanStatus.Expired;

        /* Active */
        if (loanData.state == LoanLibrary.LoanState.Active) return LoanStatus.Active;

        return LoanStatus.Unknown;
    }

    /**
     * @inheritdoc ILoanAdapter
     */
    function getLiquidateCalldata(uint256 loanId, bytes memory) external view returns (address, bytes memory) {
        return (address(_repaymentController), abi.encodeWithSignature("claim(uint256)", loanId));
    }
}
