// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.17;

import "../../rates/DynamicTargetUtilizationInterestRateModel.sol";

/**
 * @title Test Contract Wrapper for DynamicTargetUtilizationInterestRateModel
 * @author MetaStreet Labs
 */
contract TestDynamicTargetUtilizationInterestRateModel is DynamicTargetUtilizationInterestRateModel {
    /**************************************************************************/
    /* Constructor */
    /**************************************************************************/

    constructor(Parameters memory params) {
        _initialize(params);
    }

    /**************************************************************************/
    /* Wrapper Functions */
    /**************************************************************************/

    function onUtilizationUpdated(uint256 utilization) external {
        _onUtilizationUpdated(utilization);
    }
}
