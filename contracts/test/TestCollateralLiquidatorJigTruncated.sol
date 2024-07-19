// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.25;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC721/utils/ERC721Holder.sol";

import "../LoanReceipt.sol";

import "../interfaces/ICollateralLiquidator.sol";

/**
 * @title Truncated Testing Jig for Collateral Liquidators
 * @author MetaStreet Labs
 */
contract TestCollateralLiquidatorJigTruncated is ERC721Holder {
    using SafeERC20 for IERC20;

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
}
