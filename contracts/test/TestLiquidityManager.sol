// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.17;

import "../LiquidityManager.sol";

/**
 * @title Test Contract Wrapper for LiquidityManager
 * @author MetaStreet Labs
 */
contract TestLiquidityManager is LiquidityManager {
    /**
     * @dev External wrapper function for LiquidityManager.liquidityForecast()
     */
    function liquidityForecast(uint128 startDepth, uint128 amount) external view returns (uint16, uint16) {
        return _liquidityForecast(startDepth, amount);
    }

    /**
     * @dev External wrapper function for LiquidityManager.liquiditySource()
     */
    function liquiditySource(uint128 startDepth, uint128 amount) external view returns (LiquiditySource[] memory) {
        return _liquiditySource(startDepth, amount);
    }

    /**
     * @dev External wrapper function for LiquidityManager.liquidityInsantiate()
     */
    function liquidityInstantiate(uint128 depth) external {
        return _liquidityInstantiate(depth);
    }

    /**
     * @dev External wrapper function for LiquidityManager.liquidityDeposit()
     */
    function liquidityDeposit(uint128 depth, uint128 amount) external returns (uint256) {
        return _liquidityDeposit(depth, amount);
    }

    /**
     * @dev External wrapper function for LiquidityManager.liquidityRedeem()
     */
    function liquidityRedeem(uint128 depth, uint128 shares) external returns (uint128, uint128) {
        return _liquidityRedeem(depth, shares);
    }

    /**
     * @dev External wrapper function for LiquidityManager.liquidityUse()
     */
    function liquidityUse(uint128 depth, uint128 amount, uint128 pending) external {
        return _liquidityUse(depth, amount, pending);
    }

    /**
     * @dev External wrapper function for LiquidityManager.liquidityRestore()
     */
    function liquidityRestore(uint128 depth, uint128 used, uint128 pending, uint128 restored) external {
        return _liquidityRestore(depth, used, pending, restored);
    }

    /**
     * @dev External wrapper function for LiquidityManager.liquidityProcessRedemptions()
     */
    function liquidityProcessRedemptions(uint128 depth) external returns (uint128, uint128) {
        return _liquidityProcessRedemptions(depth);
    }

    /**
     * @dev External wrapper function for LiquidityManager.liquidityRedemptionAvailable()
     */
    function liquidityRedemptionAvailable(
        uint128 depth,
        uint128 pending,
        uint128 index,
        uint128 target
    ) external view returns (uint128, uint128) {
        return _liquidityRedemptionAvailable(depth, pending, index, target);
    }
}
