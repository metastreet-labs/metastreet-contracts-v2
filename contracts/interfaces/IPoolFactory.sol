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
     * @param deploymentHash Deployment hash
     */
    event PoolCreated(address indexed pool, bytes32 indexed deploymentHash);

    /**************************************************************************/
    /* API */
    /**************************************************************************/

    /**
     * Create a pool (immutable)
     * @param poolImplementation Pool implementation contract
     * @param params Pool parameters
     * @return Pool address
     */
    function create(address poolImplementation, bytes calldata params) external returns (address);

    /**
     * Create a pool (proxied)
     * @param poolBeacon Pool beacon contract
     * @param params Pool parameters
     * @return Pool address
     */
    function createProxied(address poolBeacon, bytes calldata params) external returns (address);

    /**
     * @notice Check if address is a pool
     * @param pool Pool address
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
