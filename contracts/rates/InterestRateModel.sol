// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "../LiquidityLogic.sol";

/**
 * @title Interest Rate Model API
 * @author MetaStreet Labs
 */
abstract contract InterestRateModel {
    /**************************************************************************/
    /* Errors */
    /**************************************************************************/

    /**
     * @notice Invalid parameters
     */
    error InvalidInterestRateModelParameters();

    /**************************************************************************/
    /* API */
    /**************************************************************************/

    /**
     * @notice Get interest rate model name
     * @return Interest rate model name
     */
    function INTEREST_RATE_MODEL_NAME() external view virtual returns (string memory);

    /**
     * @notice Get interest rate model version
     * @return Interest rate model version
     */
    function INTEREST_RATE_MODEL_VERSION() external view virtual returns (string memory);

    /**
     * @notice Price interest for liquidity
     * @param principal Principal
     * @param duration Duration
     * @param nodes Liquidity nodes
     * @param count Liquidity node count
     * @param rates Interest rates
     * @param adminFeeRate Admin fee rate
     * @return repayment Repayment
     * @return adminFee Admin fee
     */
    function _price(
        uint256 principal,
        uint64 duration,
        LiquidityLogic.NodeSource[] memory nodes,
        uint16 count,
        uint64[] memory rates,
        uint32 adminFeeRate
    ) internal view virtual returns (uint256 repayment, uint256 adminFee);
}
