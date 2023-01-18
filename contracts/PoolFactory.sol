// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.17;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

import "./interfaces/IPoolFactory.sol";
import "./interfaces/ICollateralFilter.sol";
import "./interfaces/ICollateralLiquidator.sol";
import "./Pool.sol";

/*
 * @title PoolFactory
 * @author MetaStreet
 */
contract PoolFactory is IPoolFactory {
    using EnumerableSet for EnumerableSet.AddressSet;

    /**
     * @notice set of all deployed pools
     */
    EnumerableSet.AddressSet private _pools;

    /*
     * @inheritdoc IPoolFactory
     */
    function createPool(bytes calldata params) external returns (address) {
        (
            IERC20 currencyToken,
            uint64 maxLoanDuration,
            ICollateralFilter collateralFilter,
            IInterestRateModel interestRateModel,
            ICollateralLiquidator collateralLiquidator
        ) = abi.decode(params, (IERC20, uint64, ICollateralFilter, IInterestRateModel, ICollateralLiquidator));
        Pool pool = new Pool(currencyToken, maxLoanDuration, collateralFilter, interestRateModel, collateralLiquidator);
        address poolAddress = address(pool);
        _pools.add(poolAddress);
        emit PoolCreated(poolAddress);
        return poolAddress;
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
}
