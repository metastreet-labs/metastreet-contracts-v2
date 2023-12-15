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
     * Distribute pending to liquidity, and calculate repayment and admin fee
     * @param duration Duration
     * @param adminFeeRate Admin fee rate
     * @param rates Rates
     * @param nodes Liquidity nodes
     * @return Repayment, Admin Fee
     */
    function _distribute(
        uint64 duration,
        uint32 adminFeeRate,
        uint64[] memory rates,
        LiquidityLogic.NodeSource[] memory nodes
    ) internal view virtual returns (uint256, uint256);
}
