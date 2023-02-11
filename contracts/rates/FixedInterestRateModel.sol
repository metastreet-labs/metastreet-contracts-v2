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
     * @notice Initialized boolean
     */
    bool private _initialized;

    /**
     * @notice Owner
     */
    address private _owner;

    /**
     * @notice Fixed interest rate
     */
    uint128 private _fixedInterestRate;

    /**
     * @notice Utilization
     * @dev Currently unused, but updated to simulate storage costs.
     */
    uint128 private _utilization;

    /**************************************************************************/
    /* Constructor */
    /**************************************************************************/

    /**
     * @notice FixedInterestRateModel constructor
     */
    constructor() {
        /* Disable initialization of implementation contract */
        _initialized = true;
    }

    /**************************************************************************/
    /* Initializer */
    /**************************************************************************/

    /**
     * @notice Initializer
     * @param params ABI-encoded parameters
     */
    function initialize(bytes memory params) external {
        require(!_initialized, "Already initialized");

        _initialized = true;
        _owner = msg.sender;
        _fixedInterestRate = uint128(abi.decode(params, (uint256)));
    }

    /**************************************************************************/
    /* Getters */
    /**************************************************************************/

    /**
     * @notice Get fixed interest rate
     * @return Fixed interest rate
     */
    function fixedInterestRate() external view returns (uint256) {
        return _fixedInterestRate;
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
    function price(uint16, uint16) external view returns (uint256) {
        return _fixedInterestRate;
    }

    /**
     * @inheritdoc IInterestRateModel
     */
    function distribute(
        uint256 amount,
        uint256 interest,
        ILiquidity.NodeSource[] memory nodes,
        uint16 count
    ) external pure returns (ILiquidity.NodeSource[] memory, uint16) {
        uint128 interestPerNode = uint128(Math.mulDiv(interest, FIXED_POINT_SCALE, count * FIXED_POINT_SCALE));

        uint128 taken;
        uint16 i;
        for (; taken < amount; i++) {
            uint128 take = uint128(Math.min(Math.min(nodes[i].depth - taken, nodes[i].available), amount - taken));
            nodes[i].available -= take;
            nodes[i].used = take;
            nodes[i].pending = take + uint128(Math.min(interestPerNode, interest));
            interest -= interestPerNode;
            taken += take;
        }

        /* Assign any remaining interest to final node */
        nodes[i - 1].pending += uint128(interest);

        return (nodes, i);
    }

    /**
     * @inheritdoc IInterestRateModel
     */
    function onUtilizationUpdated(uint256 utilization) external {
        if (msg.sender != _owner) revert("Invalid caller");

        _utilization = uint128(utilization);
    }
}
