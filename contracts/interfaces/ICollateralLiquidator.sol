// SPDX-License-Identifier: MIT
pragma solidity 0.8.17;

/**
 * @title Interface to a Collateral Liquidator
 */
interface ICollateralLiquidator {
    /**
     * @notice Get collateral liquidator name
     * @return Collateral liquidator name
     */
    function name() external view returns (string memory);

    /**
     * @notice Start collateral liquidation
     * @param currencyToken Curreny token
     * @param collateralToken Collateral token, either underlying token or collateral wrapper
     * @param collateralTokenId Collateral token ID
     * @param collateralContext Collateral context for collateral wrapper
     * @param liquidationContext Liquidation callback context
     */
    function liquidate(
        address currencyToken,
        address collateralToken,
        uint256 collateralTokenId,
        bytes calldata collateralContext,
        bytes calldata liquidationContext
    ) external;
}
