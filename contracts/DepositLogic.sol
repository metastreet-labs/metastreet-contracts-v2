// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.25;

import "./Pool.sol";
import "./Tick.sol";
import "./LiquidityLogic.sol";

import "./interfaces/IPool.sol";

/**
 * @title Deposit Logic
 * @author MetaStreet Labs
 */
library DepositLogic {
    using LiquidityLogic for LiquidityLogic.Liquidity;

    /**
     * @dev Helper function to handle deposit accounting
     * @param self Pool storage
     * @param tick Tick
     * @param amount Amount
     * @param minShares Minimum shares
     * @return Deposit shares
     */
    function _deposit(
        Pool.PoolStorage storage self,
        uint128 tick,
        uint128 amount,
        uint128 minShares
    ) external returns (uint128) {
        /* Validate tick */
        Tick.validate(tick, 0, 0, self.durations.length - 1, 0, self.rates.length - 1);

        /* Deposit into liquidity node */
        uint128 shares = self.liquidity.deposit(tick, amount);

        /* Validate shares received is sufficient */
        if (shares == 0 || shares < minShares) revert IPool.InsufficientShares();

        /* Add to deposit */
        self.deposits[msg.sender][tick].shares += shares;

        return shares;
    }

    /**
     * @dev Helper function to handle redeem accounting
     * @param self Pool storage
     * @param tick Tick
     * @param shares Shares
     * @return redemptionId Redemption ID
     */
    function _redeem(Pool.PoolStorage storage self, uint128 tick, uint128 shares) external returns (uint128) {
        /* Look up deposit */
        Pool.Deposit storage dep = self.deposits[msg.sender][tick];

        /* Assign redemption ID */
        uint128 redemptionId = dep.redemptionId++;

        /* Look up redemption */
        Pool.Redemption storage redemption = dep.redemptions[redemptionId];

        /* Validate shares */
        if (shares == 0 || shares > dep.shares) revert IPool.InsufficientShares();

        /* Redeem shares in tick with liquidity manager */
        (uint128 index, uint128 target) = self.liquidity.redeem(tick, shares);

        /* Update deposit state */
        redemption.pending = shares;
        redemption.index = index;
        redemption.target = target;

        /* Decrement deposit shares */
        dep.shares -= shares;

        return redemptionId;
    }

    /**
     * @dev Helper function to handle withdraw accounting
     * @param self Pool storage
     * @param tick Tick
     * @param redemptionId Redemption ID
     * @return Withdrawn shares and withdrawn amount
     */
    function _withdraw(
        Pool.PoolStorage storage self,
        uint128 tick,
        uint128 redemptionId
    ) external returns (uint128, uint128) {
        /* Look up redemption */
        Pool.Redemption storage redemption = self.deposits[msg.sender][tick].redemptions[redemptionId];

        /* If no redemption is pending */
        if (redemption.pending == 0) revert IPool.InvalidRedemptionStatus();

        /* Look up redemption available */
        (uint128 shares, uint128 amount, uint128 processedIndices, uint128 processedShares) = self
            .liquidity
            .redemptionAvailable(tick, redemption.pending, redemption.index, redemption.target);

        /* If the entire redemption is ready */
        if (shares == redemption.pending) {
            delete self.deposits[msg.sender][tick].redemptions[redemptionId];
        } else {
            redemption.pending -= shares;
            redemption.index += processedIndices;
            redemption.target = (processedShares < redemption.target) ? redemption.target - processedShares : 0;
        }

        return (shares, amount);
    }

    /**
     * @dev Helper function to handle transfer accounting
     * @param self Pool storage
     * @param from From
     * @param to To
     * @param tick Tick
     * @param shares Shares
     */
    function _transfer(Pool.PoolStorage storage self, address from, address to, uint128 tick, uint128 shares) external {
        if (self.deposits[from][tick].shares < shares) revert IPool.InsufficientShares();

        self.deposits[from][tick].shares -= shares;
        self.deposits[to][tick].shares += shares;
    }

    /**
     * Helper function to look up redemption available
     * @param self Pool storage
     * @param account Account
     * @param tick Tick
     * @param redemptionId Redemption ID
     * @return shares Amount of deposit shares available for redemption
     * @return amount Amount of currency tokens available for withdrawal
     * @return sharesAhead Amount of pending shares ahead in queue
     */
    function _redemptionAvailable(
        Pool.PoolStorage storage self,
        address account,
        uint128 tick,
        uint128 redemptionId
    ) external view returns (uint256 shares, uint256 amount, uint256 sharesAhead) {
        /* Look up redemption */
        Pool.Redemption storage redemption = self.deposits[account][tick].redemptions[redemptionId];

        /* If no redemption is pending */
        if (redemption.pending == 0) return (0, 0, 0);

        uint128 processedShares;
        (shares, amount, , processedShares) = self.liquidity.redemptionAvailable(
            tick,
            redemption.pending,
            redemption.index,
            redemption.target
        );

        /* Compute pending shares ahead in queue */
        sharesAhead = redemption.target > processedShares ? redemption.target - processedShares : 0;
    }
}
