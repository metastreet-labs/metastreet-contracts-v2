// SPDX-License-Identifier: BUSL-1.1

import {IAggregator} from "./IAggregator.sol";

pragma solidity ^0.8.0;

// ***************************************************************
// * ========================= STRUCTS ========================= *
// ***************************************************************

struct NumericData {
    uint256 topicId;
    uint256 timestamp;
    bytes extraData;
    uint256[] numericValues;
}

struct AlloraAdapterNumericData {
    bytes signature;
    NumericData numericData;
    bytes extraData;
}

struct TopicValue {
    uint192 recentValue;
    uint64 recentValueTime;
}

// ***************************************************************
// * ======================= INTERFACE ========================= *
// ***************************************************************

/**
 * @title Allora Adapter Interface
 */
interface IAlloraAdapter {
    /**
     * @notice Get data validity in seconds
     *
     * @return Seconds
     */
    function dataValiditySeconds(
    ) external view returns (uint256);

    /**
     * @notice Get data validity in seconds
     *
     * @return Seconds
     */
    function getMessage(NumericData memory numericData) external view returns (bytes32);

    /**
     * @notice Get a verified piece of numeric data for a given topic
     *
     * @param nd The numeric data to aggregate
     */
    function verifyData(
        AlloraAdapterNumericData memory nd
    ) external returns (uint256 numericValue, address dataProvider);

    /**
     * @notice Get a verified piece of numeric data for a given topic without mutating state
     *
     * @param pd The numeric data to aggregate
     */
    function verifyDataViewOnly(
        AlloraAdapterNumericData memory pd
    ) external view returns (uint256 numericValue, address dataProvider);

    /**
     * @notice Get the topic data for a given topicId
     *
     * @param topicId The topicId to get the topic data for
     * @param extraData The extraData to get the topic data for
     * @return topicValue The topic data
     */
    function getTopicValue(uint256 topicId, bytes calldata extraData) external view returns (TopicValue memory);
}
