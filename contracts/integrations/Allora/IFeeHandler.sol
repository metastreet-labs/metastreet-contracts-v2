// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.13;

interface IFeeHandler {
    /**
     * @notice Handle fees, sending them to the fee receivers
     *
     * @param feedOwner The owner of the feed
     * @param feeReceivers The addresses to send the fees to
     * @param extraData Extra data to be used by the fee handler
     */
    function handleFees(address feedOwner, address[] memory feeReceivers, bytes memory extraData) external payable;
}
