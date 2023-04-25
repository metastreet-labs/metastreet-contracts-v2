// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.17;

import "../../rates/WeightedInterestRateModel.sol";

/**
 * @title Test Contract Wrapper for WeightedInterestRateModel
 * @author MetaStreet Labs
 */
contract TestWeightedInterestRateModel is WeightedInterestRateModel {
    /**************************************************************************/
    /* Constructor */
    /**************************************************************************/

    constructor(Parameters memory params) {
        _initialize(params);
    }
}
