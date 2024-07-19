// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.25;

import "@openzeppelin/contracts/utils/math/Math.sol";
import "@openzeppelin/contracts/utils/math/SafeCast.sol";

import "./interfaces/ILiquidity.sol";
import "./Tick.sol";

/**
 * @title Liquidity Logic
 * @author MetaStreet Labs
 */
library LiquidityLogic {
    /*
     * Liquidity nodes are arranged in a linked-list that starts with a zero
     * sentinel and ends with an end sentinel. There are two types of ticks, namely,
     * ratio ticks and absolute ticks (see more in Tick.sol). In the linked-list,
     * ratio ticks are ordered before absolute ticks. Within the types, they are
     * ordered in ascending order of their tick values.
     *
     * +--------------------------------------------------------------------+
     * |                         Linked-List Layout                         |
     * +----------------------------------|------------------|--------------+
     * |       0       | (Limit Type = 1) | (Limit Type = 0) | Max. uint128 |
     * | Zero Sentinel |   Ratio Ticks    |  Absolute Ticks  | End Sentinel |
     * +--------------------------------------------------------------------+
     *
     */

    using SafeCast for uint256;

    /**************************************************************************/
    /* Constants */
    /**************************************************************************/

    /**
     * @notice Tick limit spacing basis points for absolute type (10%)
     */
    uint256 internal constant ABSOLUTE_TICK_LIMIT_SPACING_BASIS_POINTS = 1000;

    /**
     * @notice Tick limit spacing basis points for ratio type (5%)
     */
    uint256 internal constant RATIO_TICK_LIMIT_SPACING_BASIS_POINTS = 500;

    /**
     * @notice Fixed point scale
     */
    uint256 internal constant FIXED_POINT_SCALE = 1e18;

    /**
     * @notice Basis points scale
     */
    uint256 internal constant BASIS_POINTS_SCALE = 10_000;

    /**
     * @notice Impaired price threshold (5%)
     */
    uint256 internal constant IMPAIRED_PRICE_THRESHOLD = 0.05 * 1e18;

    /**
     * @notice Max ticks used count
     */
    uint256 private constant MAX_TICKS_USED_COUNT = 32;

    /**
     * @notice Max redemption queue scan count
     */
    uint256 private constant MAX_REDEMPTION_QUEUE_SCAN_COUNT = 150;

    /**
     * @notice Amount of shares to lock for initial deposit
     */
    uint128 private constant LOCKED_SHARES = 1e6;

    /**************************************************************************/
    /* Structures */
    /**************************************************************************/

    /**
     * @notice Node source
     * @param tick Tick
     * @param used Amount used
     * @param pending Amount pending
     */
    struct NodeSource {
        uint128 tick;
        uint128 used;
        uint128 pending;
    }

    /**
     * @notice Fulfilled redemption
     * @param shares Shares redeemed
     * @param amount Amount redeemed
     */
    struct FulfilledRedemption {
        uint128 shares;
        uint128 amount;
    }

    /**
     * @notice Redemption state
     * @param pending Pending shares
     * @param index Current index
     * @param fulfilled Fulfilled redemptions
     */
    struct Redemptions {
        uint128 pending;
        uint128 index;
        mapping(uint128 => FulfilledRedemption) fulfilled;
    }

    /**
     * @notice Accrual state
     * @param accrued Accrued interest
     * @param rate Accrual rate
     * @param timestamp Last accrual timestamp
     */
    struct Accrual {
        uint128 accrued;
        uint64 rate;
        uint64 timestamp;
    }

    /**
     * @notice Liquidity node
     * @param value Liquidity value
     * @param shares Liquidity shares outstanding
     * @param available Liquidity available
     * @param pending Liquidity pending (with interest)
     * @param prev Previous liquidity node
     * @param next Next liquidity node
     * @param redemption Redemption state
     * @param accrual Accrual state
     */
    struct Node {
        uint128 value;
        uint128 shares;
        uint128 available;
        uint128 pending;
        uint128 prev;
        uint128 next;
        Redemptions redemptions;
        Accrual accrual;
    }

    /**
     * @notice Liquidity state
     * @param nodes Liquidity nodes
     */
    struct Liquidity {
        mapping(uint256 => Node) nodes;
    }

    /**************************************************************************/
    /* Getters */
    /**************************************************************************/

    /**
     * Get liquidity node at tick
     * @param liquidity Liquidity state
     * @param tick Tick
     * @return Liquidity node
     */
    function liquidityNode(Liquidity storage liquidity, uint128 tick) public view returns (ILiquidity.NodeInfo memory) {
        Node storage node = liquidity.nodes[tick];

        return
            ILiquidity.NodeInfo({
                tick: tick,
                value: node.value,
                shares: node.shares,
                available: node.available,
                pending: node.pending,
                redemptions: node.redemptions.pending,
                prev: node.prev,
                next: node.next
            });
    }

    /**
     * @notice Count liquidity nodes spanning [startTick, endTick] range, where
     * startTick is 0 or an instantiated tick
     * @param liquidity Liquidity state
     * @param startTick Start tick
     * @param endTick End tick
     * @return count Liquidity nodes count
     */
    function liquidityNodesCount(
        Liquidity storage liquidity,
        uint128 startTick,
        uint128 endTick
    ) public view returns (uint256 count) {
        /* Validate start tick has active liquidity */
        if (liquidity.nodes[startTick].next == 0) revert ILiquidity.InactiveLiquidity();

        /* Count nodes */
        uint256 t = startTick;
        while (t != type(uint128).max && t <= endTick) {
            t = liquidity.nodes[t].next;
            count++;
        }
    }

    /**
     * @notice Get liquidity nodes spanning [startTick, endTick] range, where
     * startTick is 0 or an instantiated tick
     * @param liquidity Liquidity state
     * @param startTick Start tick
     * @param endTick End tick
     * @return Liquidity nodes
     */
    function liquidityNodes(
        Liquidity storage liquidity,
        uint128 startTick,
        uint128 endTick
    ) external view returns (ILiquidity.NodeInfo[] memory) {
        ILiquidity.NodeInfo[] memory nodes = new ILiquidity.NodeInfo[](
            liquidityNodesCount(liquidity, startTick, endTick)
        );

        /* Populate nodes */
        uint256 i;
        uint128 t = startTick;
        while (t != type(uint128).max && t <= endTick) {
            nodes[i] = liquidityNode(liquidity, t);
            t = nodes[i++].next;
        }

        return nodes;
    }

    /**
     * @notice Get liquidity node with accrual info at tick
     * @param liquidity Liquidity state
     * @param tick Tick
     * @return Liquidity node, Accrual info
     */
    function liquidityNodeWithAccrual(
        Liquidity storage liquidity,
        uint128 tick
    ) external view returns (ILiquidity.NodeInfo memory, ILiquidity.AccrualInfo memory) {
        Node storage node = liquidity.nodes[tick];

        return (
            ILiquidity.NodeInfo({
                tick: tick,
                value: node.value,
                shares: node.shares,
                available: node.available,
                pending: node.pending,
                redemptions: node.redemptions.pending,
                prev: node.prev,
                next: node.next
            }),
            ILiquidity.AccrualInfo({
                accrued: node.accrual.accrued,
                rate: node.accrual.rate,
                timestamp: node.accrual.timestamp
            })
        );
    }

    /**
     * @notice Get redemption available amount
     * @param liquidity Liquidity state
     * @param tick Tick
     * @param pending Redemption pending
     * @param index Redemption index
     * @param target Redemption target
     * @return redeemedShares Redeemed shares
     * @return redeemedAmount Redeemed amount
     * @return processedIndices Processed indices
     * @return processedShares Processed shares
     */
    function redemptionAvailable(
        Liquidity storage liquidity,
        uint128 tick,
        uint128 pending,
        uint128 index,
        uint128 target
    )
        internal
        view
        returns (uint128 redeemedShares, uint128 redeemedAmount, uint128 processedIndices, uint128 processedShares)
    {
        Node storage node = liquidity.nodes[tick];

        uint256 stopIndex = index + MAX_REDEMPTION_QUEUE_SCAN_COUNT;

        for (; processedShares < target + pending && index < stopIndex; index++) {
            if (index == node.redemptions.index) {
                /* Reached pending unfulfilled redemption */
                break;
            }

            /* Look up the next fulfilled redemption */
            FulfilledRedemption storage redemption = node.redemptions.fulfilled[index];

            /* Update processed count */
            processedIndices += 1;
            processedShares += redemption.shares;

            if (processedShares <= target) {
                /* Have not reached the redemption queue position yet */
                continue;
            } else {
                /* Compute number of shares to redeem in range of this
                 * redemption batch */
                uint128 shares = (((processedShares > target + pending) ? pending : (processedShares - target))) -
                    redeemedShares;
                /* Compute price of shares in this redemption batch */
                uint256 price = (redemption.amount * FIXED_POINT_SCALE) / redemption.shares;

                /* Accumulate redeemed shares and corresponding amount */
                redeemedShares += shares;
                redeemedAmount += Math.mulDiv(shares, price, FIXED_POINT_SCALE).toUint128();
            }
        }
    }

    /**
     * @notice Get deposit share price
     * @param liquidity Liquidity state
     * @param tick Tick
     * @return Deposit share price
     */
    function depositSharePrice(Liquidity storage liquidity, uint128 tick) external view returns (uint256) {
        Node storage node = liquidity.nodes[tick];

        /* Simulate accrual */
        uint128 accrued = node.accrual.accrued + node.accrual.rate * uint128(block.timestamp - node.accrual.timestamp);

        /* Return deposit price */
        return
            node.shares == 0
                ? FIXED_POINT_SCALE
                : (Math.min(node.value + accrued, node.available + node.pending) * FIXED_POINT_SCALE) / node.shares;
    }

    /**
     * @notice Get redemption share price
     * @param liquidity Liquidity state
     * @param tick Tick
     * @return Redemption share price
     */
    function redemptionSharePrice(Liquidity storage liquidity, uint128 tick) external view returns (uint256) {
        Node storage node = liquidity.nodes[tick];

        /* Revert if node is empty */
        if (node.value == 0 || node.shares == 0) revert ILiquidity.InactiveLiquidity();

        /* Return redemption price */
        return (node.value * FIXED_POINT_SCALE) / node.shares;
    }

    /**************************************************************************/
    /* Internal Helpers */
    /**************************************************************************/

    /**
     * @dev Check if tick is reserved
     * @param tick Tick
     * @return True if reserved, otherwise false
     */
    function _isReserved(uint128 tick) internal pure returns (bool) {
        return tick == 0 || tick == type(uint128).max;
    }

    /**
     * @dev Check if liquidity node is empty
     * @param node Liquidity node
     * @return True if empty, otherwise false
     */
    function _isEmpty(Node storage node) internal view returns (bool) {
        return node.shares <= LOCKED_SHARES && node.pending == 0;
    }

    /**
     * @dev Check if liquidity node is active
     * @param node Liquidity node
     * @return True if active, otherwise false
     */
    function _isActive(Node storage node) internal view returns (bool) {
        return node.prev != 0 || node.next != 0;
    }

    /**
     * @dev Check if liquidity node is impaired
     * @param node Liquidity node
     * @return True if impaired, otherwise false
     */
    function _isImpaired(Node storage node) internal view returns (bool) {
        /* If there's shares, but insufficient value for a stable share price */
        return node.shares != 0 && node.value * FIXED_POINT_SCALE < node.shares * IMPAIRED_PRICE_THRESHOLD;
    }

    /**
     * @notice Instantiate liquidity
     * @param liquidity Liquidity state
     * @param node Liquidity node
     * @param tick Tick
     */
    function _instantiate(Liquidity storage liquidity, Node storage node, uint128 tick) internal {
        /* If node is active, do nothing */
        if (_isActive(node)) return;
        /* If node is inactive and not empty, revert */
        if (!_isEmpty(node)) revert ILiquidity.InactiveLiquidity();

        /* Instantiate previous tick and previous node */
        uint128 prevTick;
        Node storage prevNode = liquidity.nodes[prevTick];

        /* Decode limit and limit type from new tick and next tick */
        (uint256 newLimit, , , Tick.LimitType newLimitType) = Tick.decode(tick, BASIS_POINTS_SCALE);
        (uint256 nextLimit, , , Tick.LimitType nextLimitType) = Tick.decode(prevNode.next, BASIS_POINTS_SCALE);

        /* Find prior node to new tick */
        bool isAbsoluteType = newLimitType == Tick.LimitType.Absolute;
        while (nextLimitType == newLimitType ? nextLimit < newLimit : isAbsoluteType) {
            prevTick = prevNode.next;
            prevNode = liquidity.nodes[prevTick];

            /* Decode limit and limit type from next tick */
            (nextLimit, , , nextLimitType) = Tick.decode(prevNode.next, BASIS_POINTS_SCALE);
        }

        /* Decode limit and limit type from prev tick */
        (uint256 prevLimit, , , Tick.LimitType prevLimitType) = Tick.decode(prevTick, BASIS_POINTS_SCALE);

        /* Validate tick limit spacing */
        if (isAbsoluteType) {
            /* Validate new absolute limit */
            if (
                newLimit != prevLimit &&
                prevLimitType == Tick.LimitType.Absolute &&
                newLimit <
                (prevLimit * (BASIS_POINTS_SCALE + ABSOLUTE_TICK_LIMIT_SPACING_BASIS_POINTS)) / BASIS_POINTS_SCALE
            ) revert ILiquidity.InsufficientTickSpacing();
            if (
                newLimit != nextLimit &&
                nextLimitType == Tick.LimitType.Absolute &&
                nextLimit <
                (newLimit * (BASIS_POINTS_SCALE + ABSOLUTE_TICK_LIMIT_SPACING_BASIS_POINTS)) / BASIS_POINTS_SCALE
            ) revert ILiquidity.InsufficientTickSpacing();
        } else {
            /* Validate new ratio limit */
            if (
                newLimit != prevLimit &&
                prevLimitType == Tick.LimitType.Ratio &&
                newLimit < (prevLimit + RATIO_TICK_LIMIT_SPACING_BASIS_POINTS)
            ) revert ILiquidity.InsufficientTickSpacing();
            if (
                newLimit != nextLimit &&
                nextLimitType == Tick.LimitType.Ratio &&
                nextLimit < (newLimit + RATIO_TICK_LIMIT_SPACING_BASIS_POINTS)
            ) revert ILiquidity.InsufficientTickSpacing();
        }

        /* Link new node */
        node.prev = prevTick;
        node.next = prevNode.next;
        liquidity.nodes[prevNode.next].prev = tick;
        prevNode.next = tick;
    }

    /**
     * @dev Garbage collect an impaired or empty node, unlinking it from active
     * liquidity
     * @param liquidity Liquidity state
     * @param node Liquidity node
     */
    function _garbageCollect(Liquidity storage liquidity, Node storage node) internal {
        /* If node is not impaired and not empty, or already inactive, do nothing */
        if ((!_isImpaired(node) && !_isEmpty(node)) || !_isActive(node)) return;

        /* Make node inactive by unlinking it */
        liquidity.nodes[node.prev].next = node.next;
        liquidity.nodes[node.next].prev = node.prev;
        node.next = 0;
        node.prev = 0;
    }

    /**
     * @notice Process redemptions from available liquidity
     * @param liquidity Liquidity state
     * @param node Liquidity node
     */
    function _processRedemptions(Liquidity storage liquidity, Node storage node) internal {
        /* If there's no pending shares to redeem */
        if (node.redemptions.pending == 0) return;

        /* Compute redemption price */
        uint256 price = (node.value * FIXED_POINT_SCALE) / node.shares;

        if (price == 0) {
            /* If node has pending interest */
            if (node.pending != 0) return;

            /* If node is insolvent, redeem all shares for zero amount */
            uint128 shares = node.redemptions.pending;

            /* Record fulfilled redemption */
            node.redemptions.fulfilled[node.redemptions.index++] = FulfilledRedemption({shares: shares, amount: 0});

            /* Update node state */
            node.shares -= shares;
            node.value = 0;
            node.available = 0;
            node.redemptions.pending = 0;

            return;
        } else {
            /* Node is solvent */

            /* If there's no cash to redeem from */
            if (node.available == 0) return;

            /* Redeem as many shares as possible and pending from available cash */
            uint128 shares = uint128(Math.min((node.available * FIXED_POINT_SCALE) / price, node.redemptions.pending));
            uint128 amount = Math.mulDiv(shares, price, FIXED_POINT_SCALE).toUint128();

            /* If there's insufficient cash to redeem non-zero pending shares
             * at current price */
            if (shares == 0) return;

            /* Record fulfilled redemption */
            node.redemptions.fulfilled[node.redemptions.index++] = FulfilledRedemption({
                shares: shares,
                amount: amount
            });

            /* Update node state */
            node.shares -= shares;
            node.value -= amount;
            node.available -= amount;
            node.redemptions.pending -= shares;

            /* Garbage collect node if it is now empty */
            _garbageCollect(liquidity, node);

            return;
        }
    }

    /**
     * @notice Process accrued value from accrual rate and timestamp
     * @param node Liquidity node
     */
    function _accrue(Node storage node) internal {
        node.accrual.accrued += node.accrual.rate * uint128(block.timestamp - node.accrual.timestamp);
        node.accrual.timestamp = uint64(block.timestamp);
    }

    /**************************************************************************/
    /* Primary API */
    /**************************************************************************/

    /**
     * @notice Initialize liquidity state
     * @param liquidity Liquidity state
     */
    function initialize(Liquidity storage liquidity) internal {
        /* Liquidity state defaults to zero, but need to make head and tail nodes */
        liquidity.nodes[0].next = type(uint128).max;
        /* liquidity.nodes[type(uint128).max].prev = 0 by default */
    }

    /**
     * @notice Deposit liquidity
     * @param liquidity Liquidity state
     * @param tick Tick
     * @param amount Amount
     * @return Number of shares
     */
    function deposit(Liquidity storage liquidity, uint128 tick, uint128 amount) internal returns (uint128) {
        Node storage node = liquidity.nodes[tick];

        /* If tick is reserved */
        if (_isReserved(tick)) revert ILiquidity.InactiveLiquidity();

        /* Instantiate node, if necessary */
        _instantiate(liquidity, node, tick);

        /* Process accrual */
        _accrue(node);

        /* Compute deposit price */
        uint256 price = node.shares == 0
            ? FIXED_POINT_SCALE
            : (Math.min(node.value + node.accrual.accrued, node.available + node.pending) * FIXED_POINT_SCALE) /
                node.shares;

        /* Compute shares and depositor's shares */
        uint128 shares = ((amount * FIXED_POINT_SCALE) / price).toUint128();

        /* If this is the initial deposit, lock subset of shares */
        bool initialDeposit = node.shares < LOCKED_SHARES;

        node.value += amount;
        node.shares += shares;
        node.available += amount;

        /* Process any pending redemptions from available cash */
        _processRedemptions(liquidity, node);

        return initialDeposit ? shares - LOCKED_SHARES : shares;
    }

    /**
     * @notice Use liquidity from node
     * @param liquidity Liquidity state
     * @param tick Tick
     * @param used Used amount
     * @param pending Pending amount
     * @param duration Duration
     */
    function use(Liquidity storage liquidity, uint128 tick, uint128 used, uint128 pending, uint64 duration) internal {
        Node storage node = liquidity.nodes[tick];

        node.available -= used;
        node.pending += pending;

        /* Process accrual */
        _accrue(node);
        /* Increment accrual rate */
        uint256 rate = uint256(pending - used) / duration;
        node.accrual.rate += rate.toUint64();
    }

    /**
     * @notice Restore liquidity and process pending redemptions
     * @param liquidity Liquidity state
     * @param tick Tick
     * @param used Used amount
     * @param pending Pending amount
     * @param restored Restored amount
     * @param duration Duration
     * @param elapsed Elapsed time since loan origination
     */
    function restore(
        Liquidity storage liquidity,
        uint128 tick,
        uint128 used,
        uint128 pending,
        uint128 restored,
        uint64 duration,
        uint64 elapsed
    ) internal {
        Node storage node = liquidity.nodes[tick];

        node.value = node.value - used + restored;
        node.available += restored;
        node.pending -= pending;

        /* Garbage collect node if it is now impaired */
        _garbageCollect(liquidity, node);

        /* Process any pending redemptions */
        _processRedemptions(liquidity, node);

        /* Process accrual */
        _accrue(node);
        /* Decrement accrual rate and accrued */
        uint256 rate = uint256(pending - used) / duration;
        node.accrual.rate -= rate.toUint64();
        node.accrual.accrued -= uint128(rate * elapsed);
    }

    /**
     * @notice Redeem liquidity
     * @param liquidity Liquidity state
     * @param tick Tick
     * @param shares Shares
     * @return Redemption index, Redemption target
     */
    function redeem(Liquidity storage liquidity, uint128 tick, uint128 shares) internal returns (uint128, uint128) {
        Node storage node = liquidity.nodes[tick];

        /* Redemption from inactive liquidity nodes is allowed to facilitate
         * restoring garbage collected nodes */

        /* Snapshot redemption target */
        uint128 redemptionIndex = node.redemptions.index;
        uint128 redemptionTarget = node.redemptions.pending;

        /* Add shares to pending redemptions */
        node.redemptions.pending += shares;

        /* Initialize redemption record to save gas in loan callbacks */
        if (node.redemptions.fulfilled[redemptionIndex].shares != type(uint128).max) {
            node.redemptions.fulfilled[redemptionIndex] = FulfilledRedemption({shares: type(uint128).max, amount: 0});
        }

        /* Process any pending redemptions from available cash */
        _processRedemptions(liquidity, node);

        return (redemptionIndex, redemptionTarget);
    }

    /**
     * @notice Source liquidity from nodes
     * @param liquidity Liquidity state
     * @param amount Amount
     * @param ticks Ticks to source from
     * @param multiplier Multiplier for amount
     * @param durationIndex Duration index for amount
     * @param oraclePrice Collateral token price from price oracle, if any
     * @return Sourced liquidity nodes, count of nodes
     */
    function source(
        Liquidity storage liquidity,
        uint256 amount,
        uint128[] calldata ticks,
        uint256 multiplier,
        uint256 durationIndex,
        uint256 oraclePrice
    ) internal view returns (NodeSource[] memory, uint16) {
        NodeSource[] memory sources = new NodeSource[](ticks.length);

        uint128 prevTick;
        uint256 taken;
        uint256 count;
        for (; count < ticks.length && taken != amount; count++) {
            uint128 tick = ticks[count];

            /* Validate tick and decode limit */
            uint256 limit = Tick.validate(tick, prevTick, durationIndex, oraclePrice);

            /* Look up liquidity node */
            Node storage node = liquidity.nodes[tick];

            /* Consume as much as possible up to the tick limit, amount available, and amount remaining */
            uint128 take = uint128(Math.min(Math.min(limit * multiplier - taken, node.available), amount - taken));

            /* Record the liquidity allocation in our sources list */
            sources[count] = NodeSource({tick: tick, used: take, pending: 0});

            taken += take;
            prevTick = tick;
        }

        /* If unable to source required liquidity amount from provided ticks */
        if (taken < amount) revert ILiquidity.InsufficientLiquidity();

        /* If count exceeds max number of ticks */
        if (count > MAX_TICKS_USED_COUNT) revert ILiquidity.InsufficientLiquidity();

        return (sources, count.toUint16());
    }
}
