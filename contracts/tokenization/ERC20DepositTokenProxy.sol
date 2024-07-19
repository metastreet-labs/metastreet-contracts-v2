// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.25;

import "@openzeppelin/contracts/proxy/Proxy.sol";
import "@openzeppelin/contracts/utils/Address.sol";

import "./ERC20DepositToken.sol";

/**
 * @title ERC20 Deposit Token Proxy
 * @author MetaStreet Labs
 */
contract ERC20DepositTokenProxy is Proxy {
    /**************************************************************************/
    /* Constants */
    /**************************************************************************/

    /**
     * @notice Beacon address (ERC20DepositToken)
     */
    address internal immutable _beacon;

    /**************************************************************************/
    /* Constructor */
    /**************************************************************************/

    /**
     * @notice ERC20DepositTokenProxy constructor
     *
     * @dev Set the ERC20DepositToken address as beacon
     *      and initializes the storage of the Proxy
     *
     * @param beacon Beacon address
     * @param data Initialization data
     */
    constructor(address beacon, bytes memory data) {
        _beacon = beacon;
        Address.functionDelegateCall(ERC20DepositToken(beacon).getERC20DepositTokenImplementation(), data);
    }

    /**************************************************************************/
    /* Getters */
    /**************************************************************************/

    /**
     * @notice Get implementation address
     *
     * @dev Overrides Proxy._implementation()
     *
     * @return Implementation address
     */
    function _implementation() internal view virtual override returns (address) {
        return ERC20DepositToken(_beacon).getERC20DepositTokenImplementation();
    }
}
