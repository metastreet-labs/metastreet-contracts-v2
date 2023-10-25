// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.20;

import "@openzeppelin/contracts/proxy/Proxy.sol";
import "@openzeppelin/contracts/utils/Address.sol";

import "./DepositERC20Factory.sol";

/**
 * @title Deposit Token Proxy (ERC20)
 * @author MetaStreet Labs
 */
contract DepositERC20Proxy is Proxy {
    /**************************************************************************/
    /* Constants */
    /**************************************************************************/

    address immutable _beacon;

    /**************************************************************************/
    /* Constructor */
    /**************************************************************************/

    /**
     * @notice DepositERC20Proxy constructor
     *
     * @dev Set the DepositERC20Factory address as beacon
     *      and initializes the storage of the Proxy
     *
     * @param beacon Beacon address
     * @param data Initialization data
     */
    constructor(address beacon, bytes memory data) {
        _beacon = beacon;
        Address.functionDelegateCall(DepositERC20Factory(beacon).getDepositERC20Implementation(), data);
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
        return DepositERC20Factory(_beacon).getDepositERC20Implementation();
    }
}
