// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.17;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

import "./interfaces/IPoolFactory.sol";
import "./interfaces/ICollateralLiquidator.sol";
import "./Pool.sol";
import "./integrations/DelegateCash/IDelegationRegistry.sol";

/*
 * @title PoolFactory
 * @author MetaStreet Labs
 */
contract PoolFactory is Ownable, IPoolFactory {
    using EnumerableSet for EnumerableSet.AddressSet;

    /**************************************************************************/
    /* Events */
    /**************************************************************************/

    /**
     * @notice Emitted when pool implementation is updated
     * @param implementation New Pool implementation contract
     */
    event PoolImplementationUpdated(address indexed implementation);

    /**************************************************************************/
    /* State */
    /**************************************************************************/

    /**
     * @notice Pool implementation
     */
    address private _poolImplementation;

    /**
     * @notice Set of deployed pools
     */
    EnumerableSet.AddressSet private _pools;

    /**************************************************************************/
    /* Constructor */
    /**************************************************************************/

    /*
     * @notice PoolFactory constructor
     * @param poolImplementation Pool implementation contract
     */
    constructor(address poolImplementation_) {
        _poolImplementation = poolImplementation_;
    }

    /**************************************************************************/
    /* Primary API */
    /**************************************************************************/

    /*
     * @inheritdoc IPoolFactory
     */
    function createPool(bytes calldata params) external returns (address) {
        /* Decode pool constructor arguments */
        (
            IERC721 collateralToken,
            IERC20 currencyToken,
            uint64 maxLoanDuration,
            IDelegationRegistry delegationRegistry,
            address collateralFilterImpl,
            address interestRateModelImpl,
            address collateralLiquidatorImpl,
            bytes memory collateralFilterParams,
            bytes memory interestRateModelParams,
            bytes memory collateralLiquidatorParams
        ) = abi.decode(
                params,
                (IERC721, IERC20, uint64, IDelegationRegistry, address, address, address, bytes, bytes, bytes)
            );

        /* Create pool instance */
        address poolInstance = Clones.clone(_poolImplementation);
        Address.functionCall(
            poolInstance,
            abi.encodeCall(
                Pool.initialize,
                (
                    msg.sender,
                    collateralToken,
                    currencyToken,
                    maxLoanDuration,
                    delegationRegistry,
                    collateralFilterImpl,
                    interestRateModelImpl,
                    collateralLiquidatorImpl,
                    collateralFilterParams,
                    interestRateModelParams,
                    collateralLiquidatorParams
                )
            )
        );

        /* Add pool to registry */
        _pools.add(poolInstance);

        /* Emit Pool Created */
        emit PoolCreated(poolInstance);

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
     * @notice Get Pool Implementation
     * @return Pool implementation contract address
     */
    function poolImplementation() external view returns (address) {
        return _poolImplementation;
    }

    /**
     * @notice Set Pool Implementation
     * @param implementation New Pool implementation contract
     */
    function setPoolImplementation(address implementation) external onlyOwner {
        _poolImplementation = implementation;

        /* Emit Pool Implementation Updated */
        emit PoolImplementationUpdated(implementation);
    }

    /**
     * @notice Unregister Pool
     * @param pool Pool address
     */
    function unregisterPool(address pool) external onlyOwner {
        _pools.remove(pool);
    }
}
