// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/**
 * @title Interface to DepositERC20
 */
interface IDepositERC20 {
    function onExternalTransfer(address from, address to, uint256 value) external;
}
