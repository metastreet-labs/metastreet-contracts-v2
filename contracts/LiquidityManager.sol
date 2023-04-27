// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.17;

import "@openzeppelin/contracts/utils/math/Math.sol";
import "@openzeppelin/contracts/utils/math/SafeCast.sol";

import "./interfaces/ILiquidity.sol";
import "./Tick.sol";

library LiquidityManager {
    using SafeCast for uint256;

    /**************************************************************************/
    /* Constants */
    /**************************************************************************/

    /**
     * @notice Tick limit spacing basis points (10%)
     */
    uint256 public constant TICK_LIMIT_SPACING_BASIS_POINTS = 1000;

    /**
     * @notice Fixed point scale
     */
    uint256 internal constant FIXED_POINT_SCALE = 1e18;

    /**
     * @notice Basis points scale
     */
    uint256 internal constant BASIS_POINTS_SCALE = 10_000;

    /**************************************************************************/
    /* Errors */
    /**************************************************************************/

    /**
     * @notice Insufficient liquidity
     */
    error InsufficientLiquidity();

    /**
     * @notice Inactive liquidity
     */
    error InactiveLiquidity();

    /**
     * @notice Insolvent liquidity
     */
    error InsolventLiquidity();

    /**
     * @notice Insufficient tick spacing
     */
    error InsufficientTickSpacing();

    /**************************************************************************/
    /* Structures */
    /**************************************************************************/

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
     * @notice Liquidity node
     * @param value Liquidity value
     * @param shares Liquidity shares outstanding
     * @param available Liquidity available
     * @param pending Liquidity pending (with interest)
     * @param redemption Redemption state
     * @param prev Previous liquidity node
     * @param next Next liquidity node
     */
    struct Node {
        uint128 value;
        uint128 shares;
        uint128 available;
        uint128 pending;
        uint128 prev;
        uint128 next;
        Redemptions redemptions;
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
    function liquidityNode(
        Liquidity storage liquidity,
        uint128 tick
    ) internal view returns (ILiquidity.NodeInfo memory) {
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
     * Get liquidity nodes spanning [startTick, endTick] range
     * @param startTick Start tick
     * @param endTick End tick
     * @return Liquidity nodes
     */
    function liquidityNodes(
        Liquidity storage liquidity,
        uint128 startTick,
        uint128 endTick
    ) internal view returns (ILiquidity.NodeInfo[] memory) {
        /* Count nodes first to figure out how to size liquidity nodes array */
        uint256 i = 0;
        uint128 t = startTick;
        while (t != type(uint128).max && t <= endTick) {
            Node storage node = liquidity.nodes[t];
            i++;
            t = node.next;
        }

        ILiquidity.NodeInfo[] memory nodes = new ILiquidity.NodeInfo[](i);

        /* Populate nodes */
        i = 0;
        t = startTick;
        while (t != type(uint128).max && t <= endTick) {
            Node storage node = liquidity.nodes[t];
            nodes[i++] = ILiquidity.NodeInfo({
                tick: t,
                value: node.value,
                shares: node.shares,
                available: node.available,
                pending: node.pending,
                redemptions: node.redemptions.pending,
                prev: node.prev,
                next: node.next
            });
            t = node.next;
        }

        return nodes;
    }

    /**
     * @notice Get redemption available amount
     * @param liquidity Liquidity state
     * @param tick Tick
     * @param index Redemption index
     * @param target Redemption target
     * @param pending Redemption pending
     * @return Redeemed shares, redeemed amount
     */
    function redemptionAvailable(
        Liquidity storage liquidity,
        uint128 tick,
        uint128 pending,
        uint128 index,
        uint128 target
    ) internal view returns (uint128, uint128) {
        Node storage node = liquidity.nodes[tick];

        uint128 processedShares = 0;
        uint128 totalRedeemedShares = 0;
        uint128 totalRedeemedAmount = 0;

        for (; processedShares < target + pending; index++) {
            FulfilledRedemption storage redemption = node.redemptions.fulfilled[index];
            if (index == node.redemptions.index) {
                /* Reached pending redemption */
                break;
            }

            processedShares += redemption.shares;
            if (processedShares < target) {
                continue;
            } else {
                uint128 shares = (((processedShares > target + pending) ? pending : (processedShares - target))) -
                    totalRedeemedShares;
                uint256 price = Math.mulDiv(redemption.amount, FIXED_POINT_SCALE, redemption.shares);

                totalRedeemedShares += shares;
                totalRedeemedAmount += Math.mulDiv(shares, price, FIXED_POINT_SCALE).toUint128();
            }
        }

        return (totalRedeemedShares, totalRedeemedAmount);
    }

    /**************************************************************************/
    /* Internal Helpers */
    /**************************************************************************/

    /**
     * @dev Check if tick is reserved
     * @param tick Tick
     * @return True if resreved, otherwise false
     */
    function _isReserved(uint128 tick) internal pure returns (bool) {
        return tick == 0 || tick == type(uint128).max;
    }

    /**
     * @dev Check if liquidity node is inactive
     * @param node Liquidity node
     * @return True if inactive, otherwise false
     */
    function _isInactive(Node storage node) internal view returns (bool) {
        return node.prev == 0 && node.next == 0;
    }

    /**
     * @dev Check if liquidity node is insolvent
     * @param node Liquidity node
     * @return True if insolvent, otherwise false
     */
    function _isInsolvent(Node storage node) internal view returns (bool) {
        /* If there's shares, but insufficient value to compute a non-zero share price */
        return node.shares != 0 && (node.value * FIXED_POINT_SCALE < node.shares);
    }

    /**
     * @dev Garbage collect a node
     * @param node Liquidity node
     */
    function _garbageCollect(Liquidity storage liquidity, Node storage node) internal {
        /* If node is still solvent (non-zero shares and non-zero value), leave it in place */
        if (node.shares != 0 && !_isInsolvent(node)) return;

        /* Make node inactive by unlinking it */
        liquidity.nodes[node.prev].next = node.next;
        liquidity.nodes[node.next].prev = node.prev;
        node.next = 0;
        node.prev = 0;

        /* Handle insolvent dust */
        if (node.value > 0) {
            node.value = 0;
            node.available = 0;
        }
    }

    /**************************************************************************/
    /* Primary API */
    /**************************************************************************/

    /**
     * @notice Initialize liquidity state
     * @param liquidity Liquidity state
     */
    function initialize(Liquidity storage liquidity) internal {
        /* Liquidity state defaults to zero, but need to make head node */
        Node storage node = liquidity.nodes[0];
        node.next = type(uint128).max;
    }

    /**
     * @notice Instantiate liquidity
     * @param liquidity Liquidity state
     * @param tick Tick
     */
    function instantiate(Liquidity storage liquidity, uint128 tick) internal {
        Node storage node = liquidity.nodes[tick];

        /* If tick is reserved */
        if (_isReserved(tick)) revert InactiveLiquidity();
        /* If node is active, do nothing */
        if (!_isInactive(node)) return;
        /* If node is insolvent, refuse to link */
        if (_isInsolvent(node)) revert InsolventLiquidity();

        /* Find prior node to new tick */
        uint128 prevTick = 0;
        Node storage prevNode = liquidity.nodes[prevTick];
        while (prevNode.next < tick) {
            prevTick = prevNode.next;
            prevNode = liquidity.nodes[prevTick];
        }

        /* Decode limits from previous tick, new tick, and next tick */
        (uint256 prevLimit, , , ) = Tick.decode(prevTick);
        (uint256 newLimit, , , ) = Tick.decode(tick);
        (uint256 nextLimit, , , ) = Tick.decode(prevNode.next);

        /* Validate tick limit spacing */
        if (
            newLimit != prevLimit &&
            newLimit < (prevLimit * (BASIS_POINTS_SCALE + TICK_LIMIT_SPACING_BASIS_POINTS)) / BASIS_POINTS_SCALE
        ) revert InsufficientTickSpacing();
        if (
            newLimit != nextLimit &&
            nextLimit < (newLimit * (BASIS_POINTS_SCALE + TICK_LIMIT_SPACING_BASIS_POINTS)) / BASIS_POINTS_SCALE
        ) revert InsufficientTickSpacing();

        /* Link new node */
        node.prev = prevTick;
        node.next = prevNode.next;
        if (prevNode.next != type(uint128).max) liquidity.nodes[prevNode.next].prev = tick;
        prevNode.next = tick;
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
        if (_isReserved(tick)) revert InactiveLiquidity();
        /* If node is inactive */
        if (_isInactive(node)) revert InactiveLiquidity();

        uint256 price = node.shares == 0
            ? FIXED_POINT_SCALE
            : Math.mulDiv(
                node.value + (node.available + node.pending - node.value) / 2,
                FIXED_POINT_SCALE,
                node.shares
            );
        uint128 shares = Math.mulDiv(amount, FIXED_POINT_SCALE, price).toUint128();

        node.value += amount;
        node.shares += shares;
        node.available += amount;

        return shares;
    }

    /**
     * @notice Use liquidity from node
     * @param liquidity Liquidity state
     * @param tick Tick
     * @param used Used amount
     * @param pending Pending Amount
     */
    function use(Liquidity storage liquidity, uint128 tick, uint128 used, uint128 pending) internal {
        Node storage node = liquidity.nodes[tick];

        unchecked {
            node.available -= used;
            node.pending += pending;
        }
    }

    /**
     * @notice Restore liquidity and process pending redemptions
     * @param liquidity Liquidity state
     * @param tick Tick
     * @param used Used amount
     * @param pending Pending amount
     * @param restored Restored amount
     */
    function restore(
        Liquidity storage liquidity,
        uint128 tick,
        uint128 used,
        uint128 pending,
        uint128 restored
    ) internal {
        Node storage node = liquidity.nodes[tick];

        unchecked {
            uint128 delta = (restored > used) ? (restored - used) : (used - restored);

            node.value = (restored > used) ? (node.value + delta) : (node.value - delta);
            node.available += restored;
            node.pending -= pending;
        }

        /* Garbage collect node if it is now insolvent */
        _garbageCollect(liquidity, node);

        processRedemptions(liquidity, tick);
    }

    /**
     * @notice Redeem liquidity
     * @param liquidity Liquidity state
     * @param tick Tick
     * @param shares Shares
     * @return Redemption index, Redemption target
     */
    function redeem(Liquidity storage liquidity, uint128 tick, uint128 shares) internal returns (uint128, uint128) {
        /* If tick is reserved */
        if (_isReserved(tick)) revert InactiveLiquidity();

        Node storage node = liquidity.nodes[tick];

        /* Redemption from inactive liquidity nodes is allowed to facilitate
         * garbage collection of insolvent nodes */

        /* Snapshot redemption target */
        uint128 redemptionIndex = node.redemptions.index;
        uint128 redemptionTarget = node.redemptions.pending;

        /* Add shares to pending redemptions */
        node.redemptions.pending += shares;

        /* Initialize redemption record to save gas in loan callbacks */
        if (node.redemptions.fulfilled[node.redemptions.index].shares != type(uint128).max) {
            node.redemptions.fulfilled[node.redemptions.index] = FulfilledRedemption({
                shares: type(uint128).max,
                amount: 0
            });
        }

        return (redemptionIndex, redemptionTarget);
    }

    /**
     * @notice Process redemptions from available liquidity
     * @param liquidity Liquidity state
     * @param tick Tick
     * @return Shares redeemed, amount redeemed
     */
    function processRedemptions(Liquidity storage liquidity, uint128 tick) internal returns (uint128, uint128) {
        Node storage node = liquidity.nodes[tick];

        /* If there's no pending shares to redeem */
        if (node.redemptions.pending == 0) return (0, 0);

        /* If node is insolvent, redeem all pending shares for zero amount */
        if (_isInsolvent(node)) {
            /* Process all pending shares */
            uint128 shares = node.redemptions.pending;

            /* Record fullfiled redemption */
            node.redemptions.fulfilled[node.redemptions.index] = FulfilledRedemption({
                shares: node.redemptions.pending,
                amount: 0
            });

            /* Update node state */
            node.shares -= shares;
            /* node.value and node.available already zero */
            node.redemptions.pending -= shares;
            node.redemptions.index += 1;

            return (shares, 0);
        } else {
            /* Node is solvent */

            /* If there's no cash to redeem from */
            if (node.available == 0) return (0, 0);

            /* Redeem as many shares as possible and pending from available cash */
            uint256 price = Math.mulDiv(node.value, FIXED_POINT_SCALE, node.shares);
            uint128 shares = Math
                .min(Math.mulDiv(node.available, FIXED_POINT_SCALE, price), node.redemptions.pending)
                .toUint128();
            uint128 amount = Math.mulDiv(shares, price, FIXED_POINT_SCALE).toUint128();

            /* Record fullfiled redemption */
            node.redemptions.fulfilled[node.redemptions.index] = FulfilledRedemption({shares: shares, amount: amount});

            /* Update node state */
            node.shares -= shares;
            node.value -= amount;
            node.available -= amount;
            node.redemptions.pending -= shares;
            node.redemptions.index += 1;

            /* Garbage collect node if it is now empty */
            _garbageCollect(liquidity, node);

            return (shares, amount);
        }
    }

    /**
     * @notice Source liquidity from nodes
     * @param liquidity Liquidity state
     * @param amount Amount
     * @param ticks Ticks to source from
     * @param multiplier Multiplier for amount
     * @param durationIndex Duration index for amount
     * @return Sourced liquidity nodes, count of nodes
     */
    function source(
        Liquidity storage liquidity,
        uint256 amount,
        uint128[] calldata ticks,
        uint256 multiplier,
        uint256 durationIndex
    ) internal view returns (ILiquidity.NodeSource[] memory, uint16) {
        ILiquidity.NodeSource[] memory sources = new ILiquidity.NodeSource[](ticks.length);

        uint256 prevLimit;
        uint256 taken;
        uint256 count;
        for (; count < ticks.length && taken != amount; count++) {
            uint128 tick = ticks[count];

            /* Validate tick and decode limit */
            uint256 limit = Tick.validate(tick, prevLimit, durationIndex);

            /* Look up liquidity node */
            Node storage node = liquidity.nodes[tick];

            /* Consume as much as possible up to the tick limit, amount available, and amount remaining */
            uint128 take = uint128(Math.min(Math.min(limit * multiplier - taken, node.available), amount - taken));

            /* Record the liquidity allocation in our sources list */
            sources[count] = ILiquidity.NodeSource({tick: tick, used: take});

            taken += take;
            prevLimit = limit;
        }

        if (taken < amount) revert InsufficientLiquidity();

        return (sources, uint16(count));
    }
}
