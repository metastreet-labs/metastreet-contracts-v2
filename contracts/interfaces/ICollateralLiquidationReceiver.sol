// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

/**
 * @title Interface to a Collateral Liquidation Receiver
 */
interface ICollateralLiquidationReceiver {
    /**
     * @notice Callback on collateral liquidated
     * @param liquidationContext Liquidation context
     * @param proceeds Liquidation proceeds in currency tokens
     */
    function onCollateralLiquidated(bytes calldata liquidationContext, uint256 proceeds) external;
}
