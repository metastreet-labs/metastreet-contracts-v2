// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.13;

interface IAggregator {
    /**
     * The aggregate function to be used for aggregating price provider values according to various strategies
     *
     * @param values The values to aggregate
     * @param extraData Extra data to be used by the aggregator
     */
    function aggregate(uint256[] memory values, bytes memory extraData) external view returns (uint256 value);
}
