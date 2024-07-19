// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.25;

import "../interfaces/ILiquidity.sol";
import "../LiquidityLogic.sol";

/**
 * @title Test Contract Wrapper for LiquidityLogic
 * @author MetaStreet Labs
 */
contract TestLiquidityLogic is ILiquidity {
    using LiquidityLogic for LiquidityLogic.Liquidity;

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

    /**************************************************************************/
    /* State */
    /**************************************************************************/

    /**
     * @notice Liquidity
     */
    LiquidityLogic.Liquidity internal _liquidity;

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
    function liquidityNodes(uint128 startTick, uint128 endTick) external view returns (ILiquidity.NodeInfo[] memory) {
        return _liquidity.liquidityNodes(startTick, endTick);
    }

    /**
     * @inheritdoc ILiquidity
     */
    function liquidityNode(uint128 tick) external view returns (ILiquidity.NodeInfo memory) {
        return _liquidity.liquidityNode(tick);
    }

    /**
     * @inheritdoc ILiquidity
     */
    function liquidityNodeWithAccrual(
        uint128 tick
    ) external view returns (ILiquidity.NodeInfo memory, ILiquidity.AccrualInfo memory) {
        return _liquidity.liquidityNodeWithAccrual(tick);
    }

    /**
     * @inheritdoc ILiquidity
     */
    function depositSharePrice(uint128 tick) external view returns (uint256) {
        return _liquidity.depositSharePrice(tick);
    }

    /**
     * @inheritdoc ILiquidity
     */
    function redemptionSharePrice(uint128 tick) external view returns (uint256) {
        return _liquidity.redemptionSharePrice(tick);
    }

    /**************************************************************************/
    /* Wrapper for Primary API */
    /**************************************************************************/

    /**
     * @dev External wrapper function for LiquidityLogic.redemptionAvailable()
     */
    function redemptionAvailable(
        uint128 tick,
        uint128 pending,
        uint128 index,
        uint128 target
    ) external view returns (uint128 shares, uint128 amount) {
        (shares, amount, , ) = _liquidity.redemptionAvailable(tick, pending, index, target);
    }

    /**
     * @dev External wrapper function for LiquidityLogic._instantiate()
     */
    function instantiate(uint128 tick) external {
        return _liquidity._instantiate(_liquidity.nodes[tick], tick);
    }

    /**
     * @dev External wrapper function for LiquidityLogic.deposit()
     */
    function deposit(uint128 tick, uint128 amount) external returns (uint256) {
        uint128 shares = _liquidity.deposit(tick, amount);
        emit Deposited(shares);
        return shares;
    }

    /**
     * @dev External wrapper function for LiquidityLogic.use()
     */
    function use(uint128 tick, uint128 amount, uint128 pending, uint64 duration) external {
        _liquidity.use(tick, amount, pending, duration);
    }

    /**
     * @dev External wrapper function for LiquidityLogic.restore()
     */
    function restore(
        uint128 tick,
        uint128 used,
        uint128 pending,
        uint128 restored,
        uint64 duration,
        uint64 elapsed
    ) external {
        _liquidity.restore(tick, used, pending, restored, duration, elapsed);
    }

    /**
     * @dev External wrapper function for LiquidityLogic.redeem()
     */
    function redeem(uint128 tick, uint128 shares) external returns (uint128, uint128) {
        (uint128 index, uint128 target) = _liquidity.redeem(tick, shares);
        emit RedemptionTarget(index, target);
        return (index, target);
    }

    /**
     * @dev External wrapper function for LiquidityLogic.source()
     */
    function source(
        uint256 amount,
        uint128[] calldata ticks,
        uint256 multiplier,
        uint256 durationIndex,
        uint256 oraclePrice
    ) external view returns (LiquidityLogic.NodeSource[] memory, uint16 count) {
        return _liquidity.source(amount, ticks, multiplier, durationIndex, oraclePrice);
    }
}
