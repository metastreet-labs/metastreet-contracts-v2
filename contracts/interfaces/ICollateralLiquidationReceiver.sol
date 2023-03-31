// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

/**
 * @title Interface to a Collateral Liquidation Receiver
 */
interface ICollateralLiquidationReceiver {
    /**
     * @notice Callback on collateral liquidated
     * @param currencyToken Currency token
     * @param collateralToken Collateral token
     * @param collateralTokenId Collateral token ID
     * @param collateralContext Collateral context
     * @param liquidationContext Liquidation context
     * @param proceeds Liquidation proceeds in currency tokens
     */
    function onCollateralLiquidated(
        address currencyToken,
        address collateralToken,
        uint256 collateralTokenId,
        bytes calldata collateralContext,
        bytes calldata liquidationContext,
        uint256 proceeds
    ) external;
}
