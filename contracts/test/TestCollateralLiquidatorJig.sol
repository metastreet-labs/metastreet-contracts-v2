// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.20;

import "@openzeppelin/contracts/proxy/Clones.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import "@openzeppelin/contracts/token/ERC1155/IERC1155Receiver.sol";
import "@openzeppelin/contracts/utils/introspection/ERC165.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import "../LoanReceipt.sol";

import "../interfaces/ICollateralLiquidator.sol";
import "../interfaces/ICollateralLiquidationReceiver.sol";
import "../interfaces/ICollateralBidder.sol";

/**
 * @title Testing Jig for Collateral Liquidators
 * @author MetaStreet Labs
 */
contract TestCollateralLiquidatorJig is ERC165, IERC721Receiver, IERC1155Receiver, ICollateralLiquidationReceiver {
    using SafeERC20 for IERC20;

    /**************************************************************************/
    /* Errors */
    /**************************************************************************/

    /**
     * @notice Force a revert
     */
    error ForceRevert();

    /**************************************************************************/
    /* Events */
    /**************************************************************************/

    /**
     * @notice Emitted when loan collateral is liquidated
     * @param proceeds Liquidation proceeds in currency tokens
     */
    event CollateralLiquidated(uint256 proceeds);

    /**************************************************************************/
    /* State */
    /**************************************************************************/

    /**
     * @dev Currency token
     */
    IERC20 private _currencyToken;

    /**
     * @dev Collateral liquidator instance
     */
    address private _collateralLiquidator;

    /**
     * @dev Force revert flag
     */
    bool private _forceRevert = false;

    /**************************************************************************/
    /* Constructor */
    /**************************************************************************/

    /**
     * @notice TestLiquidator
     */
    constructor(IERC20 currencyToken_, address collateralLiquidator_) {
        _currencyToken = currencyToken_;
        _collateralLiquidator = collateralLiquidator_;
    }

    /**************************************************************************/
    /* Getters */
    /**************************************************************************/

    /**
     * @notice Get currency token
     * @return Currency token contract
     */
    function currencyToken() external view returns (address) {
        return address(_currencyToken);
    }

    /**
     * @notice Get collateral liquidator
     * @return Collateral liquidator contract
     */
    function collateralLiquidator() external view returns (address) {
        return address(_collateralLiquidator);
    }

    /**************************************************************************/
    /* Hooks */
    /**************************************************************************/

    function onERC721Received(address, address, uint256, bytes memory) public virtual override returns (bytes4) {
        if (_forceRevert) {
            revert ForceRevert();
        }

        return this.onERC721Received.selector;
    }

    function onERC1155Received(
        address,
        address,
        uint256,
        uint256,
        bytes memory
    ) public virtual override returns (bytes4) {
        if (_forceRevert) {
            revert ForceRevert();
        }

        return this.onERC1155Received.selector;
    }

    function onERC1155BatchReceived(
        address,
        address,
        uint256[] memory,
        uint256[] memory,
        bytes memory
    ) public virtual override returns (bytes4) {
        if (_forceRevert) {
            revert ForceRevert();
        }

        return this.onERC1155BatchReceived.selector;
    }

    /**************************************************************************/
    /* Methods */
    /**************************************************************************/

    /**
     * @notice Liquidate collateral with liquidator
     * @param encodedLoanReceipt Encoded loan receipt
     */
    function liquidate(bytes calldata encodedLoanReceipt) external {
        LoanReceipt.LoanReceiptV2 memory loanReceipt = LoanReceipt.decode(encodedLoanReceipt);

        IERC721(loanReceipt.collateralToken).approve(_collateralLiquidator, loanReceipt.collateralTokenId);

        /* Start liquidation with collateral liquidator */
        ICollateralLiquidator(_collateralLiquidator).liquidate(
            address(_currencyToken),
            loanReceipt.collateralToken,
            loanReceipt.collateralTokenId,
            loanReceipt.collateralWrapperContext,
            encodedLoanReceipt
        );
    }

    /**
     * @notice Callback on loan collateral liquidated
     * @param loanReceipt Loan receipt
     * @param proceeds Liquidation proceeds in currency tokens
     */
    function onCollateralLiquidated(bytes calldata loanReceipt, uint256 proceeds) external {
        LoanReceipt.LoanReceiptV2 memory decodedLoanReceipt = LoanReceipt.decode(loanReceipt);

        /* Force a revert to test try...catch in English Auction */
        if (decodedLoanReceipt.collateralTokenId == 130) {
            revert ForceRevert();
        }

        emit CollateralLiquidated(proceeds);
    }

    /**
     * @notice Bid on an auction
     * @param liquidationHash Liquidation hash
     * @param collateralToken Collateral token
     * @param collateralTokenId Collateral token ID
     * @param amount Bid amount
     */
    function bid(bytes32 liquidationHash, address collateralToken, uint256 collateralTokenId, uint256 amount) external {
        /* Approve bid amount */
        _currencyToken.approve(_collateralLiquidator, amount);

        /* Bid on collateral */
        ICollateralBidder(_collateralLiquidator).bid(liquidationHash, collateralToken, collateralTokenId, amount);
    }

    /**
     * @notice Claim collateral and liquidate if possible
     * @param liquidationHash Liquidation hash
     * @param collateralToken Collateral token
     * @param collateralTokenId Collateral token ID
     * @param liquidationContext Liquidation context
     * @param forceRevert Force revert
     */
    function claim(
        bytes32 liquidationHash,
        address collateralToken,
        uint256 collateralTokenId,
        bytes calldata liquidationContext,
        bool forceRevert
    ) external {
        _forceRevert = forceRevert;

        /* Claim collateral */
        ICollateralBidder(_collateralLiquidator).claim(
            liquidationHash,
            collateralToken,
            collateralTokenId,
            liquidationContext
        );
    }

    /**
     * @notice Retry claim collateral after liquidation has been processed
     * @param liquidationHash Liquidation hash
     * @param collateralToken Collateral token
     * @param collateralTokenId Collateral token ID
     * @param forceRevert Force revert
     */
    function claimRetry(
        bytes32 liquidationHash,
        address collateralToken,
        uint256 collateralTokenId,
        bool forceRevert
    ) external {
        _forceRevert = forceRevert;

        /* Claim collateral */
        ICollateralBidder(_collateralLiquidator).claimRetry(liquidationHash, collateralToken, collateralTokenId);
    }

    /******************************************************/
    /* ERC165 interface */
    /******************************************************/

    /**
     * @inheritdoc IERC165
     */
    function supportsInterface(bytes4 interfaceId) public view override(ERC165, IERC165) returns (bool) {
        return interfaceId == type(ICollateralLiquidationReceiver).interfaceId || super.supportsInterface(interfaceId);
    }
}
