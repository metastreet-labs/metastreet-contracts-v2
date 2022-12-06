// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/**
 * @title Interface to the Pool Factory
 */
interface IPoolFactory {
    event PoolCreated(address indexed vault);

    function createPool(bytes calldata params) external returns (address);

    function hasPool(address vault) external view returns (bool);

    function getPoolList() external view returns (address[] memory);

    function getPoolCount() external view returns (uint256);

    function getPoolAt(uint256 index) external view returns (address);
}
