// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.17;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/token/ERC721/utils/ERC721Holder.sol";

/**
 * @title Testing Jig for Collateral Liquidators
 * @author MetaStreet Labs
 */
contract TestCollateralLiquidatorJig is ERC721Holder {
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

    IERC20 private _currencyToken;

    /**************************************************************************/
    /* Constructor */
    /**************************************************************************/

    /**
     * @notice TestLiquidator
     */
    constructor(IERC20 currencyToken_) {
        _currencyToken = currencyToken_;
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

    /**************************************************************************/
    /* Methods */
    /**************************************************************************/

    /**
     * @notice Transfer collateral to liquidator
     * @param liquidator Liquidator address
     * @param token Token contract
     * @param tokenId Token ID
     * @param loanReceipt Encoded loan receipt
     */
    function transferCollateral(
        address liquidator,
        IERC721 token,
        uint256 tokenId,
        bytes calldata loanReceipt
    ) external {
        token.safeTransferFrom(address(this), liquidator, tokenId, loanReceipt);
    }

    /**
     * @notice Callback on loan collateral liquidated
     * @param loanReceipt Loan receipt
     * @param proceeds Liquidation proceeds in currency tokens
     */
    function onCollateralLiquidated(bytes calldata loanReceipt, uint256 proceeds) external {
        loanReceipt;
        _currencyToken.safeTransferFrom(msg.sender, address(this), proceeds);

        emit CollateralLiquidated(proceeds);
    }
}
