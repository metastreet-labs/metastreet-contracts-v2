// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.17;

import "@openzeppelin/contracts/utils/math/Math.sol";

import "./interfaces/ILiquidity.sol";

library LiquidityManager {
    /**************************************************************************/
    /* Constants */
    /**************************************************************************/

    /**
     * @notice Fixed point scale
     */
    uint256 public constant FIXED_POINT_SCALE = 1e18;

    /**
     * @notice Tick spacing basis points (25%)
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
     * @param total Total value
     * @param used Total used
     * @param numNodes Total number of nodes
     * @param nodes Liquidity nodes
     */
    struct Liquidity {
        uint128 total;
        uint128 used;
        uint16 numNodes;
        mapping(uint256 => Node) nodes;
    }

    /**************************************************************************/
    /* Getters */
    /**************************************************************************/

    /**
     * Get liquidity available up to max depth
     * @param maxDepth Max depth
     * @return Liquidity available
     */
    function liquidityAvailable(Liquidity storage liquidity, uint256 maxDepth) external view returns (uint256) {
        uint256 amount = 0;

        uint256 d = liquidity.nodes[0].next;
        while (d != type(uint128).max && d <= maxDepth) {
            Node storage node = liquidity.nodes[d];
            amount += Math.min(d - amount, node.available);
            d = node.next;
        }

        return amount;
    }

    /**
     * Get liquidity nodes spanning [startDepth, endDepth] range
     * @param startDepth Loan limit start depth
     * @param endDepth Loan limit end depth
     * @return Liquidity nodes
     */
    function liquidityNodes(
        Liquidity storage liquidity,
        uint256 startDepth,
        uint256 endDepth
    ) external view returns (ILiquidity.NodeInfo[] memory) {
        /* Count nodes first to figure out how to size liquidity nodes array */
        uint256 i = 0;
        uint128 d = uint128(startDepth);
        while (d != type(uint128).max && d <= endDepth) {
            Node storage node = liquidity.nodes[d];
            i++;
            d = node.next;
        }

        ILiquidity.NodeInfo[] memory nodes = new ILiquidity.NodeInfo[](i);

        /* Populate nodes */
        i = 0;
        d = uint128(startDepth);
        while (d != type(uint128).max && d <= endDepth) {
            Node storage node = liquidity.nodes[d];
            nodes[i++] = ILiquidity.NodeInfo({
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
     * Get liquidity node at depth
     * @param liquidity Liquidity state
     * @param depth Depth
     * @return Liquidity node
     */
    function liquidityNode(
        Liquidity storage liquidity,
        uint256 depth
    ) external view returns (ILiquidity.NodeInfo memory) {
        Node storage node = liquidity.nodes[depth];

        return
            ILiquidity.NodeInfo({
                depth: uint128(depth),
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
     * @notice Get redemption available amount
     * @param liquidity Liquidity state
     * @param depth Depth
     * @param index Redemption index
     * @param target Redemption target
     * @param pending Redemption pending
     * @return Redeemed shares, redeemed amount
     */
    function redemptionAvailable(
        Liquidity storage liquidity,
        uint128 depth,
        uint128 pending,
        uint128 index,
        uint128 target
    ) external view returns (uint128, uint128) {
        Node storage node = liquidity.nodes[depth];

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
                totalRedeemedAmount += uint128(Math.mulDiv(shares, price, FIXED_POINT_SCALE));
            }
        }

        return (totalRedeemedShares, totalRedeemedAmount);
    }

    /**************************************************************************/
    /* Internal Helpers */
    /**************************************************************************/

    /**
     * @dev Check if depth is reserved
     * @return True if resreved, otherwise false
     */
    function _isReserved(uint128 depth) internal pure returns (bool) {
        return depth == 0 || depth == type(uint128).max;
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
        return node.shares != 0 && node.value == 0;
    }

    /**************************************************************************/
    /* Primary API */
    /**************************************************************************/

    /**
     * @notice Initialize liquidity state
     * @param liquidity Liquidity state
     */
    function initialize(Liquidity storage liquidity) external {
        /* Liquidity state defaults to zero, but need to make head node */
        Node storage node = liquidity.nodes[0];
        node.next = type(uint128).max;
    }

    /**
     * @notice Source liquidity from nodes
     * @param liquidity Liquidity state
     * @param amount Amount
     * @param depths Depths to source from
     * @return Sourced liquidity nodes, count of nodes
     */
    function source(
        Liquidity storage liquidity,
        uint256 amount,
        uint256[] calldata depths
    ) internal view returns (ILiquidity.NodeSource[] memory, uint16) {
        ILiquidity.NodeSource[] memory sources = new ILiquidity.NodeSource[](depths.length);

        uint128 taken = 0;
        uint16 count = 0;
        for (count = 0; count < depths.length && taken != amount; count++) {
            uint128 depth = uint128(depths[count]);
            Node storage node = liquidity.nodes[depth];

            uint128 take = uint128(Math.min(Math.min(depth - taken, node.available), amount - taken));
            sources[count].depth = uint128(depth);
            sources[count].available = node.available;
            taken += take;
        }

        if (taken < amount) revert InsufficientLiquidity();

        return (sources, count);
    }

    /**
     * @notice Instantiate liquidity
     * @param liquidity Liquidity state
     * @param depth Depth
     */
    function instantiate(Liquidity storage liquidity, uint128 depth) external {
        Node storage node = liquidity.nodes[depth];

        /* If node is active, do nothing */
        if (!_isInactive(node)) return;
        /* If node is insolvent, refuse to link */
        if (_isInsolvent(node)) revert InsolventLiquidity();

        /* Find prior node */
        uint128 prevDepth = 0;
        Node storage prevNode = liquidity.nodes[prevDepth];
        while (prevNode.next < depth && prevNode.next != type(uint128).max) {
            prevDepth = prevNode.next;
            prevNode = liquidity.nodes[prevDepth];
        }

        /* Validate new node tick spacing */
        if (depth < (prevDepth * TICK_SPACING_BASIS_POINTS) / 10000) revert InsufficientTickSpacing();
        if (prevNode.next > 0 && prevNode.next < (depth * TICK_SPACING_BASIS_POINTS) / 10000)
            revert InsufficientTickSpacing();

        /* Link new node */
        node.prev = prevDepth;
        node.next = prevNode.next;
        if (prevNode.next != 0) liquidity.nodes[prevNode.next].prev = depth;
        prevNode.next = depth;
        liquidity.numNodes++;
    }

    /**
     * @notice Deposit liquidity
     * @param liquidity Liquidity state
     * @param depth Depth
     * @param amount Amount
     * @return Number of shares
     */
    function deposit(Liquidity storage liquidity, uint128 depth, uint128 amount) external returns (uint128) {
        Node storage node = liquidity.nodes[depth];

        /* If depth is reserved or node is inactive */
        if (_isReserved(depth) || _isInactive(node)) revert InactiveLiquidity();

        uint256 price = node.shares == 0
            ? FIXED_POINT_SCALE
            : Math.mulDiv(node.available + node.pending, FIXED_POINT_SCALE, node.shares);
        uint128 shares = uint128(Math.mulDiv(amount, FIXED_POINT_SCALE, price));

        node.value += amount;
        node.shares += shares;
        node.available += amount;

        liquidity.total += amount;

        return shares;
    }

    /**
     * @notice Use liquidity from node
     * @dev Note, does not update liquidity statistics
     * @param liquidity Liquidity state
     * @param depth Depth
     * @param used Used amount
     * @param pending Pending Amount
     */
    function use(Liquidity storage liquidity, uint128 depth, uint128 used, uint128 pending) internal {
        Node storage node = liquidity.nodes[depth];

        unchecked {
            node.available -= used;
            node.pending += pending;
        }
    }

    /**
     * @notice Restore liquidity and process pending redemptions
     * @dev Note, does not update liquidity statistics
     * @param liquidity Liquidity state
     * @param depth Depth
     * @param used Used amount
     * @param pending Pending amount
     * @param restored Restored amount
     */
    function restore(
        Liquidity storage liquidity,
        uint128 depth,
        uint128 used,
        uint128 pending,
        uint128 restored
    ) internal {
        Node storage node = liquidity.nodes[depth];

        unchecked {
            node.value = (restored > used) ? (node.value + restored - used) : (node.value - used + restored);
            node.available += restored;
            node.pending -= pending;
        }

        /* If node became insolvent */
        if (_isInsolvent(node)) {
            /* Make node inactive by unlinking it */
            liquidity.nodes[node.prev].next = node.next;
            liquidity.nodes[node.next].prev = node.prev;
            node.next = 0;
            node.prev = 0;
            liquidity.numNodes--;
        }

        processRedemptions(liquidity, depth);
    }

    /**
     * @notice Redeem liquidity
     * @param liquidity Liquidity state
     * @param depth Depth
     * @param shares Shares
     * @return Redemption index, Redemption target
     */
    function redeem(Liquidity storage liquidity, uint128 depth, uint128 shares) external returns (uint128, uint128) {
        Node storage node = liquidity.nodes[depth];

        /* If depth is reserved */
        if (_isReserved(depth)) revert InactiveLiquidity();

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
     * @param depth Depth
     * @return Shares redeemed, amount redeemed
     */
    function processRedemptions(Liquidity storage liquidity, uint128 depth) public returns (uint128, uint128) {
        Node storage node = liquidity.nodes[depth];

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

            liquidity.total -= amount;

            return (shares, amount);
        }
    }
}
