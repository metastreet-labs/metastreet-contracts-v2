// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.17;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Upgrade.sol";
import "@openzeppelin/contracts/proxy/Clones.sol";
import "@openzeppelin/contracts/proxy/beacon/BeaconProxy.sol";
import "@openzeppelin/contracts/proxy/beacon/UpgradeableBeacon.sol";
import "@openzeppelin/contracts/proxy/transparent/TransparentUpgradeableProxy.sol";

import "./interfaces/IPoolFactory.sol";

/*
 * @title PoolFactory
 * @author MetaStreet Labs
 */
contract PoolFactory is Ownable, ERC1967Upgrade, IPoolFactory {
    using EnumerableSet for EnumerableSet.AddressSet;

    /**************************************************************************/
    /* Constants */
    /**************************************************************************/

    /**
     * @notice Implementation version
     */
    string public constant IMPLEMENTATION_VERSION = "1.0";

    /**************************************************************************/
    /* State */
    /**************************************************************************/

    /**
     * @notice Initialized boolean
     */
    bool private _initialized;

    /**
     * @notice Set of deployed pools
     */
    EnumerableSet.AddressSet private _pools;

    /**************************************************************************/
    /* Constructor */
    /**************************************************************************/

    /**
     * @notice PoolFactory constructor
     */
    constructor() {
        /* Disable initialization of implementation contract */
        _initialized = true;

        /* Disable owner of implementation contract */
        renounceOwnership();
    }

    /**************************************************************************/
    /* Initializer */
    /**************************************************************************/

    /**
     * @notice PoolFactory initializator
     */
    function initialize() external {
        require(!_initialized, "Already initialized");

        _initialized = true;
        _transferOwnership(msg.sender);
    }

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

    /*
     * @inheritdoc IPoolFactory
     */
    function createProxied(
        address poolBeacon,
        bytes calldata params,
        address collateralLiquidator
    ) external returns (address) {
        /* Compute deployment hash */
        bytes32 deploymentHash = keccak256(abi.encodePacked(block.chainid, poolBeacon, collateralLiquidator));

        /* Create pool instance */
        address poolInstance = address(
            new BeaconProxy(
                poolBeacon,
                abi.encodeWithSignature("initialize(bytes,address)", params, collateralLiquidator)
            )
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
     * @notice Get Proxy Implementation
     * @return Implementation address
     */
    function getImplementation() external view returns (address) {
        return _getImplementation();
    }

    /**
     * @notice Upgrade Proxy
     * @param newImplementation New implementation contract
     * @param data Optional calldata
     */
    function upgradeToAndCall(address newImplementation, bytes calldata data) external onlyOwner {
        _upgradeToAndCall(newImplementation, data, false);
    }
}
