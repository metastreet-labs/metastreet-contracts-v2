// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.17;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import "@openzeppelin/contracts/proxy/Clones.sol";

import "./interfaces/IPoolFactory.sol";

/*
 * @title PoolFactory
 * @author MetaStreet Labs
 */
contract PoolFactory is Ownable, IPoolFactory {
    using EnumerableSet for EnumerableSet.AddressSet;

    /**************************************************************************/
    /* State */
    /**************************************************************************/

    /**
     * @notice Set of deployed pools
     */
    EnumerableSet.AddressSet private _pools;

    /**************************************************************************/
    /* Constructor */
    /**************************************************************************/

    /*
     * @notice PoolFactory constructor
     */
    constructor() {}

    /**************************************************************************/
    /* Primary API */
    /**************************************************************************/

    /*
     * @inheritdoc IPoolFactory
     */
    function create(
        address poolImplementation,
        bytes calldata params,
        address collateralLiquidator
    ) external returns (address) {
        /* Compute deployment hash */
        bytes32 deploymentHash = keccak256(abi.encodePacked(block.chainid, poolImplementation, collateralLiquidator));

        /* Create pool instance */
        address poolInstance = Clones.clone(poolImplementation);
        Address.functionCall(
            poolInstance,
            abi.encodeWithSignature("initialize(bytes,address)", params, collateralLiquidator)
        );

        /* Add pool to registry */
        _pools.add(poolInstance);

        /* Emit Pool Created */
        emit PoolCreated(poolInstance, deploymentHash);

        return poolInstance;
    }

    /**
     * @inheritdoc IPoolFactory
     */
    function isPool(address pool) external view returns (bool) {
        return _pools.contains(pool);
    }

    /**
     * @inheritdoc IPoolFactory
     */
    function getPools() external view returns (address[] memory) {
        return _pools.values();
    }

    /**
     * @inheritdoc IPoolFactory
     */
    function getPoolCount() external view returns (uint256) {
        return _pools.length();
    }

    /**
     * @inheritdoc IPoolFactory
     */
    function getPoolAt(uint256 index) external view returns (address) {
        return _pools.at(index);
    }

    /**************************************************************************/
    /* Admin API */
    /**************************************************************************/

    /**
     * @notice Unregister Pool
     * @param pool Pool address
     */
    function unregisterPool(address pool) external onlyOwner {
        _pools.remove(pool);
    }
}
