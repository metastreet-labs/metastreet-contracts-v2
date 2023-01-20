// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.17;

import "@openzeppelin/contracts/utils/math/Math.sol";

import "./interfaces/ILiquidityManager.sol";

contract LiquidityManager is ILiquidityManager {
    /**************************************************************************/
    /* Constants */
    /**************************************************************************/

    /**
     * @notice Fixed point scale
     */
    uint256 public constant FIXED_POINT_SCALE = 1e18;

    /**
     * @notice Tick spacing basis points
     */
    uint256 public constant TICK_SPACING_BASIS_POINTS = 12500;

    /**
     * @notice Maximum number of nodes that can be sourced at once
     */
    uint256 public constant MAX_NUM_NODES = 16;

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
     * @param value Total liquidity value
     * @param shares Total liquidity shares outstanding
     * @param available Liquidity available
     * @param pending Liquidity pending (with interest)
     * @param redemption Redemption state
     * @param prev Previous liquidity node
     * @param next Next liquidity node
     */
    struct LiquidityNode {
        uint128 value;
        uint128 shares;
        uint128 available;
        uint128 pending;
        Redemptions redemptions;
        uint128 prev;
        uint128 next;
    }

    /**
     * @notice Liquidity state
     * @param value Total value
     * @param used Total used
     * @param numNodes Total number of nodes
     * @param nodes Liquidity nodes
     */
    struct Liquidity {
        uint128 value;
        uint128 used;
        uint16 numNodes;
        mapping(uint256 => LiquidityNode) nodes;
    }

    /**************************************************************************/
    /* State */
    /**************************************************************************/

    /**
     * @notice Liquidity state
     */
    Liquidity internal _liquidity;

    /**************************************************************************/
    /* Public Getters */
    /**************************************************************************/

    /**
     * @inheritdoc ILiquidityManager
     */
    function utilization() public view returns (uint256) {
        return Math.mulDiv(_liquidity.used, FIXED_POINT_SCALE, _liquidity.value);
    }

    /**
     * @inheritdoc ILiquidityManager
     */
    function liquidityTotals() public view returns (uint256, uint256) {
        return (_liquidity.value, _liquidity.used);
    }

    /**
     * @inheritdoc ILiquidityManager
     */
    function liquidityAvailable(uint256 maxDepth) external view returns (uint256) {
        uint256 amount = 0;

        uint256 d = _liquidity.nodes[0].next;
        while (d != 0 && d <= maxDepth) {
            LiquidityNode storage node = _liquidity.nodes[d];
            amount += Math.min(d - amount, node.available);
            d = node.next;
        }

        return amount;
    }

    /**
     * @inheritdoc ILiquidityManager
     */
    function liquidityNodes(uint256 startDepth, uint256 endDepth) external view returns (LiquidityNodeInfo[] memory) {
        startDepth = (startDepth == 0) ? _liquidity.nodes[0].next : startDepth;

        /* Count nodes first to figure out how to size liquidity nodes array */
        uint256 i = 0;
        uint128 d = uint128(startDepth);
        while (d != 0 && d <= endDepth) {
            LiquidityNode storage node = _liquidity.nodes[d];
            i++;
            d = node.next;
        }

        LiquidityNodeInfo[] memory nodes = new LiquidityNodeInfo[](i);

        /* Populate nodes */
        i = 0;
        d = uint128(startDepth);
        while (d != 0 && d <= endDepth) {
            LiquidityNode storage node = _liquidity.nodes[d];
            nodes[i++] = LiquidityNodeInfo({
                depth: d,
                value: node.value,
                shares: node.shares,
                available: node.available,
                pending: node.pending,
                redemptions: node.redemptions.pending,
                prev: node.prev,
                next: node.next
            });
            d = node.next;
        }

        return nodes;
    }

    /**
     * @inheritdoc ILiquidityManager
     */
    function liquidityNodeIsActive(uint256 depth) external view returns (bool) {
        return _isActive(_liquidity.nodes[depth]);
    }

    /**
     * @inheritdoc ILiquidityManager
     */
    function liquidityNodeIsSolvent(uint256 depth) external view returns (bool) {
        return _isSolvent(_liquidity.nodes[depth]);
    }

    /**************************************************************************/
    /* Internal API */
    /**************************************************************************/

    /**
     * @dev Check if liquidity node is active
     * @param node Liquidity node
     * @return True if active, otherwise false
     */
    function _isActive(LiquidityNode storage node) internal view returns (bool) {
        return node.prev == 0 && node.next == 0;
    }

    /**
     * @dev Check if liquidity node is solvent
     * @param node Liquidity node
     * @return True if solvent, otherwise false
     */
    function _isSolvent(LiquidityNode storage node) internal view returns (bool) {
        return node.shares == 0 || node.value != 0;
    }

    /**
     * @notice Source liquidity from nodes
     * @param startDepth Start depth
     * @param amount Total amount
     * @return Liquidity trail
     */
    function _liquiditySource(uint128 startDepth, uint128 amount) internal view returns (LiquiditySource[] memory) {
        LiquiditySource[] memory trail = new LiquiditySource[](MAX_NUM_NODES);

        uint128 taken = 0;
        uint16 i = 0;
        uint128 d = (startDepth == 0) ? _liquidity.nodes[0].next : startDepth;
        while (taken < amount && d != 0 && i < MAX_NUM_NODES) {
            LiquidityNode storage node = _liquidity.nodes[d];

            uint128 take = uint128(Math.min(Math.min(d - taken, node.available), amount - taken));
            trail[i++] = LiquiditySource({depth: d, used: take, pending: take});

            taken += take;
            d = node.next;
        }

        if (taken < amount) revert InsufficientLiquidity();

        return trail;
    }

    /**
     * @notice Instantiate liquidity
     * @param depth Depth
     */
    function _liquidityInstantiate(uint128 depth) internal {
        LiquidityNode storage node = _liquidity.nodes[depth];

        /* If node exists, is active, return */
        if (_isActive(node)) return;
        /* If node exists, but is insolvent, refuse to link */
        if (!_isSolvent(node)) revert InsolventLiquidity();

        /* Find prior node */
        uint128 prevDepth = 0;
        LiquidityNode storage prevNode = _liquidity.nodes[prevDepth];
        while (prevNode.next < depth && prevNode.next != 0) {
            prevDepth = prevNode.next;
            prevNode = _liquidity.nodes[prevDepth];
        }

        /* Validate new node tick spacing */
        if (depth < (prevDepth * TICK_SPACING_BASIS_POINTS) / 10000) revert InsufficientTickSpacing();
        if (prevNode.next < (depth * TICK_SPACING_BASIS_POINTS) / 10000) revert InsufficientTickSpacing();

        /* Link new node */
        node.prev = prevDepth;
        node.next = prevNode.next;
        if (prevNode.next != 0) _liquidity.nodes[prevNode.next].prev = depth;
        prevNode.next = depth;
        _liquidity.numNodes++;
    }

    /**
     * @notice Deposit liquidity
     * @param depth Depth
     * @param amount Amount
     * @return Number of shares
     */
    function _liquidityDeposit(uint128 depth, uint128 amount) internal returns (uint128) {
        LiquidityNode storage node = _liquidity.nodes[depth];

        /* If node is inactive */
        if (depth == 0 || !_isActive(node)) revert InactiveLiquidity();
        /* If node is insolvent */
        if (!_isSolvent(node)) revert InsolventLiquidity();

        uint256 price = node.shares == 0
            ? FIXED_POINT_SCALE
            : Math.mulDiv(node.available + node.pending, FIXED_POINT_SCALE, node.shares);
        uint128 shares = uint128(Math.mulDiv(amount, price, FIXED_POINT_SCALE));

        node.value += amount;
        node.shares += shares;
        node.available += amount;

        _liquidity.value += amount;

        return shares;
    }

    /**
     * @notice Redeem liquidity
     * @param depth Depth
     * @param shares Shares
     * @return Redemption index, Redemption target
     */
    function _liquidityRedeem(uint128 depth, uint128 shares) internal returns (uint128, uint128) {
        LiquidityNode storage node = _liquidity.nodes[depth];

        /* Redemption from inactive or insolvent liquidity node is allowed to
         * facilitate garbage collection of the node */

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
     * @notice Use liquidity
     * @param depth Depth
     * @param amount Amount
     * @param pending Pending Amount
     */
    function _liquidityUse(uint128 depth, uint128 amount, uint128 pending) internal {
        LiquidityNode storage node = _liquidity.nodes[depth];
        if (node.available < amount) revert InsufficientLiquidity();

        node.available -= amount;
        node.pending += pending;

        _liquidity.used += amount;
    }

    /**
     * @notice Restore liquidity and process pending redemptions
     * @param depth Depth
     * @param used Used amount
     * @param pending Pending amount
     * @param restored Restored amount
     */
    function _liquidityRestore(uint128 depth, uint128 used, uint128 pending, uint128 restored) internal {
        LiquidityNode storage node = _liquidity.nodes[depth];

        int256 delta = int256(uint256(restored)) - int256(uint256(used));

        node.value = (delta > 0) ? node.value + uint128(uint256(delta)) : node.value - uint128(uint256(-delta));
        node.available += restored;
        node.pending -= pending;

        _liquidity.value = (delta > 0)
            ? _liquidity.value + uint128(uint256(delta))
            : _liquidity.value - uint128(uint256(-delta));
        _liquidity.used -= used;

        /* If node became insolvent */
        if (!_isSolvent(node)) {
            /* Make node inactive by unlinking it */
            _liquidity.nodes[node.prev].next = node.next;
            _liquidity.nodes[node.next].prev = node.prev;
            node.next = 0;
            node.prev = 0;
            _liquidity.numNodes--;
        }

        _liquidityProcessRedemptions(depth);
    }

    /**
     * @notice Process redemptions from available liquidity
     * @param depth Depth
     * @return Shares redeemed, amount redeemed
     */
    function _liquidityProcessRedemptions(uint128 depth) internal returns (uint128, uint128) {
        LiquidityNode storage node = _liquidity.nodes[depth];

        /* If there's no pending shares to redeem */
        if (node.redemptions.pending == 0) return (0, 0);

        /* If node is insolvent, redeem all pending shares for zero amount */
        if (!_isSolvent(node)) {
            uint128 shares = node.redemptions.pending;

            node.redemptions.fulfilled[node.redemptions.index] = FulfilledRedemption({
                shares: node.redemptions.pending,
                amount: 0
            });

            node.shares -= shares;
            /* node.value and node.available already zero */
            node.redemptions.pending -= shares;
            node.redemptions.index += 1;

            return (shares, 0);
        } else {
            /* Node is solvent */

            /* If there's no cash to redeem from */
            if (node.available == 0) return (0, 0);

            uint256 price = Math.mulDiv(node.value, FIXED_POINT_SCALE, node.shares);
            uint128 shares = uint128(
                Math.min(Math.mulDiv(node.available, FIXED_POINT_SCALE, price), node.redemptions.pending)
            );
            uint128 amount = uint128(Math.mulDiv(shares, price, FIXED_POINT_SCALE));

            /* Record fullfiled redemption */
            node.redemptions.fulfilled[node.redemptions.index] = FulfilledRedemption({shares: shares, amount: amount});

            /* Update node state */
            node.shares -= shares;
            node.value -= amount;
            node.available -= amount;
            node.redemptions.pending -= shares;
            node.redemptions.index += 1;

            _liquidity.value -= amount;

            return (shares, amount);
        }
    }

    /**
     * @notice Get redemption available amount
     * @param depth Depth
     * @param index Redemption index
     * @param target Redemption target
     * @param pending Redemption pending
     * @return Redeemed shares, redeemed amount
     */
    function _liquidityRedemptionAvailable(
        uint128 depth,
        uint128 pending,
        uint128 index,
        uint128 target
    ) internal view returns (uint128, uint128) {
        LiquidityNode storage node = _liquidity.nodes[depth];

        uint128 processedShares = 0;
        uint128 totalRedeemedShares = 0;
        uint128 totalRedeemedAmount = 0;

        for (; processedShares < target + pending; index++) {
            FulfilledRedemption storage redemption = node.redemptions.fulfilled[index];
            if (redemption.shares == type(uint128).max) {
                /* Reached pending unfulfilled redemption  */
                break;
            }

            processedShares += redemption.shares;
            if (processedShares < target) {
                continue;
            } else {
                uint128 shares = (processedShares > target + pending ? pending : processedShares - target) -
                    totalRedeemedShares;
                uint256 price = Math.mulDiv(redemption.amount, FIXED_POINT_SCALE, node.shares);

                totalRedeemedShares += shares;
                totalRedeemedAmount += uint128(Math.mulDiv(shares, price, FIXED_POINT_SCALE));
            }
        }

        return (totalRedeemedShares, totalRedeemedAmount);
    }
}
