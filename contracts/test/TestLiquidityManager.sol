// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.17;

import "../interfaces/ILiquidity.sol";
import "../LiquidityManager.sol";

/**
 * @title Test Contract Wrapper for LiquidityManager
 * @author MetaStreet Labs
 */
contract TestLiquidityManager is ILiquidity {
    using LiquidityManager for LiquidityManager.Liquidity;

    /**************************************************************************/
    /* State */
    /**************************************************************************/

    /**
     * @notice Liquidity
     */
    LiquidityManager.Liquidity internal _liquidity;

    /**************************************************************************/
    /* ILiquidity Getters */
    /**************************************************************************/

    /**
     * @inheritdoc ILiquidity
     */
    function utilization() public view returns (uint256) {
        return Math.mulDiv(_liquidity.used, LiquidityManager.FIXED_POINT_SCALE, _liquidity.value);
    }

    /**
     * @inheritdoc ILiquidity
     */
    function liquidityTotals() external view returns (uint256, uint256) {
        return (_liquidity.value, _liquidity.used);
    }

    /**
     * @inheritdoc ILiquidity
     */
    function liquidityAvailable(uint256 maxDepth) external view returns (uint256) {
        return _liquidity.liquidityAvailable(maxDepth);
    }

    /**
     * @inheritdoc ILiquidity
     */
    function liquidityNodes(
        uint256 startDepth,
        uint256 endDepth
    ) external view returns (ILiquidity.LiquidityNodeInfo[] memory) {
        return _liquidity.liquidityNodes(startDepth, endDepth);
    }

    /**
     * @inheritdoc ILiquidity
     */
    function liquidityNodeIsSolvent(uint256 depth) external view returns (bool) {
        return _liquidity.liquidityNodeIsSolvent(depth);
    }

    /**
     * @inheritdoc ILiquidity
     */
    function liquidityNodeIsActive(uint256 depth) external view returns (bool) {
        return _liquidity.liquidityNodeIsActive(depth);
    }

    /**************************************************************************/
    /* Wrapper for Primary API */
    /**************************************************************************/

    /**
     * @dev External wrapper function for LiquidityManager.forecast()
     */
    function forecast(uint128 startDepth, uint128 amount) external view returns (uint16, uint16) {
        return _liquidity.forecast(startDepth, amount);
    }

    /**
     * @dev External wrapper function for LiquidityManager.source()
     */
    function source(uint128 startDepth, uint128 amount) external view returns (ILiquidity.LiquiditySource[] memory) {
        return _liquidity.source(startDepth, amount);
    }

    /**
     * @dev External wrapper function for LiquidityManager.instantiate()
     */
    function instantiate(uint128 depth) external {
        return _liquidity.instantiate(depth);
    }

    /**
     * @dev External wrapper function for LiquidityManager.deposit()
     */
    function deposit(uint128 depth, uint128 amount) external returns (uint256) {
        return _liquidity.deposit(depth, amount);
    }

    /**
     * @dev External wrapper function for LiquidityManager.use()
     */
    function use(uint128 depth, uint128 amount, uint128 pending) external {
        return _liquidity.use(depth, amount, pending);
    }

    /**
     * @dev External wrapper function for LiquidityManager.restore()
     */
    function restore(uint128 depth, uint128 used, uint128 pending, uint128 restored) external {
        return _liquidity.restore(depth, used, pending, restored);
    }

    /**
     * @dev External wrapper function for LiquidityManager.redeem()
     */
    function redeem(uint128 depth, uint128 shares) external returns (uint128, uint128) {
        return _liquidity.redeem(depth, shares);
    }

    /**
     * @dev External wrapper function for LiquidityManager.processRedemptions()
     */
    function processRedemptions(uint128 depth) external returns (uint128, uint128) {
        return _liquidity.processRedemptions(depth);
    }

    /**
     * @dev External wrapper function for LiquidityManager.redemptionAvailable()
     */
    function redemptionAvailable(
        uint128 depth,
        uint128 pending,
        uint128 index,
        uint128 target
    ) external view returns (uint128, uint128) {
        return _liquidity.redemptionAvailable(depth, pending, index, target);
    }
}
