// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/**
 * @title Interface to the Pool Factory
 */
interface IPoolFactory {
    /**************************************************************************/
    /* Events */
    /**************************************************************************/

    /**
     * @notice Emitted when a pool is created
     * @param pool Pool address
     */
    event PoolCreated(address indexed pool);

    /**************************************************************************/
    /* API */
    /**************************************************************************/

    /**
     * Create a pool
     * @param params Constructor parameters
     * @return Pool address
     */
    function createPool(bytes calldata params) external returns (address);

    /**
     * @notice Check if address is a pool
     * @return True if address is a pool, otherwise false
     */
    function isPool(address pool) external view returns (bool);

    /**
     * @notice Get list of pools
     * @return List of pool addresses
     */
    function getPools() external view returns (address[] memory);

    /**
     * @notice Get count of pools
     * @return Count of pools
     */
    function getPoolCount() external view returns (uint256);

    /**
     * @notice Get pool at index
     * @param index Index
     * @return Pool address
     */
    function getPoolAt(uint256 index) external view returns (address);
}
