// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.17;

import "../../rates/FixedInterestRateModel.sol";

/**
 * @title Test Contract Wrapper for FixedInterestRateModel
 * @author MetaStreet Labs
 */
contract TestFixedInterestRateModel is FixedInterestRateModel {
    /**************************************************************************/
    /* Constructor */
    /**************************************************************************/

    constructor(Parameters memory params) {
        _initialize(params);
    }
}
