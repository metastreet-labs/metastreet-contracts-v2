// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/**
 * @title Interface to a Collateral Liquidator Bidder
 */
interface ICollateralBidder {
    /**
     * @notice Bid on an auction
     * @param liquidationHash Liquidation hash
     * @param collateralToken Collateral token
     * @param collateralTokenId Collateral token ID
     * @param amount Bid amount
     */
    function bid(bytes32 liquidationHash, address collateralToken, uint256 collateralTokenId, uint256 amount) external;

    /**
     * @notice Claim collateral and liquidate if possible
     * @param liquidationHash Liquidation hash
     * @param collateralToken Collateral token
     * @param collateralTokenId Collateral token ID
     * @param liquidationContext Liquidation context
     */
    function claim(
        bytes32 liquidationHash,
        address collateralToken,
        uint256 collateralTokenId,
        bytes calldata liquidationContext
    ) external;

    /**
     * @notice Retry claim collateral after liquidation has been processed
     * @param liquidationHash Liquidation hash
     * @param collateralToken Collateral token
     * @param collateralTokenId Collateral token ID
     */
    function claimRetry(bytes32 liquidationHash, address collateralToken, uint256 collateralTokenId) external;
}
