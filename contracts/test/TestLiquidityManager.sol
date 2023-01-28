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
    /* Events */
    /**************************************************************************/

    /**
     * @notice Emitted with return value from deposit()
     * @param shares Shares created
     */
    event Deposited(uint128 shares);

    /**
     * @notice Emitted with return values from redeem()
     * @param index Redemption index
     * @param target Redemption target
     */
    event RedemptionTarget(uint128 index, uint128 target);

    /**
     * @notice Emitted with return values from processRedemptions()
     * @param shares Shares redeemed
     * @param amount Amount redeemed
     */
    event RedemptionProcessed(uint128 shares, uint128 amount);

    /**************************************************************************/
    /* State */
    /**************************************************************************/

    /**
     * @notice Liquidity
     */
    LiquidityManager.Liquidity internal _liquidity;

    /**************************************************************************/
    /* Constructor */
    /**************************************************************************/

    constructor() {
        _liquidity.initialize();
    }

    /**************************************************************************/
    /* ILiquidity Getters */
    /**************************************************************************/

    /**
     * @inheritdoc ILiquidity
     */
    function utilization() public view returns (uint256) {
        return Math.mulDiv(_liquidity.used, LiquidityManager.FIXED_POINT_SCALE, _liquidity.total);
    }

    /**
     * @inheritdoc ILiquidity
     */
    function liquidityStatistics() external view returns (uint256, uint256, uint16) {
        return (_liquidity.total, _liquidity.used, _liquidity.numNodes);
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
    function liquidityNodes(uint256 startDepth, uint256 endDepth) external view returns (ILiquidity.NodeInfo[] memory) {
        return _liquidity.liquidityNodes(startDepth, endDepth);
    }

    /**
     * @inheritdoc ILiquidity
     */
    function liquidityNode(uint256 depth) external view returns (ILiquidity.NodeInfo memory) {
        return _liquidity.liquidityNode(depth);
    }

    /**************************************************************************/
    /* Wrapper for Primary API */
    /**************************************************************************/

    /**
     * @dev External wrapper function for LiquidityManager.source()
     */
    function source(uint128 startDepth, uint128 amount) external view returns (ILiquidity.NodeSource[] memory, uint16) {
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
        uint128 shares = _liquidity.deposit(depth, amount);
        emit Deposited(shares);
        return shares;
    }

    /**
     * @dev External wrapper function for LiquidityManager.use()
     */
    function use(uint128 depth, uint128 amount, uint128 pending) external {
        _liquidity.use(depth, amount, pending);

        /* Update liquidity statistics */
        _liquidity.used += amount;
    }

    /**
     * @dev External wrapper function for LiquidityManager.restore()
     */
    function restore(uint128 depth, uint128 used, uint128 pending, uint128 restored) external {
        _liquidity.restore(depth, used, pending, restored);

        /* Update liquidity statistics */
        _liquidity.total = (restored > used)
            ? (_liquidity.total + restored - used)
            : (_liquidity.total - used + restored);
        _liquidity.used -= used;
    }

    /**
     * @dev External wrapper function for LiquidityManager.redeem()
     */
    function redeem(uint128 depth, uint128 shares) external returns (uint128, uint128) {
        (uint128 index, uint128 target) = _liquidity.redeem(depth, shares);
        emit RedemptionTarget(index, target);
        return (index, target);
    }

    /**
     * @dev External wrapper function for LiquidityManager.processRedemptions()
     */
    function processRedemptions(uint128 depth) external returns (uint128, uint128) {
        (uint128 shares, uint128 amount) = _liquidity.processRedemptions(depth);
        emit RedemptionProcessed(shares, amount);
        return (shares, amount);
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
