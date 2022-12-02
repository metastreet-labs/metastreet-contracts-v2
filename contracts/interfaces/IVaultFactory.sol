// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/**
 * @title Interface to the Vault Factory
 */
interface IVaultFactory {
    event VaultCreated(address indexed vault);

    function createVault(bytes calldata params) external returns (address);

    function hasVault(address vault) external view returns (bool);

    function getVaultList() external view returns (address[] memory);

    function getVaultCount() external view returns (uint256);

    function getVaultAt(uint256 index) external view returns (address);
}
