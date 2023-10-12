// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/**
 * @title Interface to Liquidity state
 */
interface IDeposit {
    /**
     * @notice Redemption
     * @param pending Redemption shares pending
     * @param index Redemption queue index
     * @param target Redemption queue target
     */
    struct Redemption {
        uint128 pending;
        uint128 index;
        uint128 target;
    }

    /**
     * @notice Deposit
     * @param shares Shares
     * @param redemptionId Next Redemption ID
     * @param redemptions Mapping of redemption ID to redemption
     */
    struct Deposit {
        uint128 shares;
        uint128 redemptionId;
        mapping(uint128 => Redemption) redemptions;
    }
}
