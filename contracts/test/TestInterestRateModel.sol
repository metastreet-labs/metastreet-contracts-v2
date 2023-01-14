// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.17;

import "@openzeppelin/contracts/utils/math/Math.sol";

import "../interfaces/IInterestRateModel.sol";

/**
 * @title Test Interest Rate Model with constant, fixed rate
 * @author MetaStreet Labs
 */
contract TestInterestRateModel is IInterestRateModel {
    /**************************************************************************/
    /* Constants */
    /**************************************************************************/

    /**
     * @notice Fixed point scale
     */
    uint256 public constant FIXED_POINT_SCALE = 1e18;

    /**************************************************************************/
    /* State */
    /**************************************************************************/

    /**
     * @notice Fixed interest rate
     */
    uint256 public immutable fixedInterestRate;

    /**
     * @notice Utilization
     * @dev Currently unused, but updated to simulate storage costs.
     */
    uint256 private _utilization;

    /**************************************************************************/
    /* Constructor */
    /**************************************************************************/

    /**
     * @notice TestInterestRateModel constructor
     * @param fixedInterestRate_ Fixed interest rate
     */
    constructor(uint256 fixedInterestRate_) {
        fixedInterestRate = fixedInterestRate_;
    }

    /**************************************************************************/
    /* Implementation */
    /**************************************************************************/

    /**
     * @inheritdoc IInterestRateModel
     */
    function name() external pure returns (string memory) {
        return "TestInterestRateModel";
    }

    /**
     * @inheritdoc IInterestRateModel
     */
    function calculateRate(uint128, uint16) external view returns (uint256) {
        return fixedInterestRate;
    }

    /**
     * @inheritdoc IInterestRateModel
     */
    function distributeInterest(
        uint128 interest,
        ILiquidityManager.LiquiditySource[] memory trail
    ) external pure returns (ILiquidityManager.LiquiditySource[] memory) {
        uint128 interestPerTick = uint128(Math.mulDiv(interest, FIXED_POINT_SCALE, trail.length));

        for (uint256 i; i < trail.length - 1; i++) {
            trail[i].pending += interestPerTick;
            interest -= interestPerTick;
        }
        trail[trail.length - 1].pending += interest;

        return trail;
    }

    /**
     * @inheritdoc IInterestRateModel
     */
    function onUtilizationUpdated(uint256 utilization) external {
        _utilization = utilization;
    }
}
