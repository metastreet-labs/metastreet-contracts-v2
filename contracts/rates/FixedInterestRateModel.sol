// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.17;

import "@openzeppelin/contracts/utils/math/Math.sol";

import "../interfaces/IInterestRateModel.sol";

/**
 * @title Fixed Interest Rate Model with a constant, fixed rate used for
 * testing.
 * @author MetaStreet Labs
 */
contract FixedInterestRateModel is IInterestRateModel {
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
     * @notice FixedInterestRateModel constructor
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
        return "FixedInterestRateModel";
    }

    /**
     * @inheritdoc IInterestRateModel
     */
    function calculateRate(uint16, uint16) external view returns (uint256) {
        return fixedInterestRate;
    }

    /**
     * @inheritdoc IInterestRateModel
     */
    function distributeInterest(uint128 interest, ILiquidityManager.LiquiditySource[] memory trail) external pure {
        uint256 numNodes;
        while (trail[numNodes].depth != 0) {
            numNodes++;
        }

        uint128 interestPerNode = uint128(Math.mulDiv(interest, FIXED_POINT_SCALE, numNodes));

        for (uint256 i; i < numNodes - 1; i++) {
            trail[i].pending += interestPerNode;
            interest -= interestPerNode;
        }
        trail[numNodes - 1].pending += interest;
    }

    /**
     * @inheritdoc IInterestRateModel
     */
    function onUtilizationUpdated(uint256 utilization) external {
        _utilization = utilization;
    }
}