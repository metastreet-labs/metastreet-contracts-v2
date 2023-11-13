// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

/**
 * @title Deposit Token API
 * @author MetaStreet Labs
 */
abstract contract DepositToken {
    /**************************************************************************/
    /* Events */
    /**************************************************************************/

    /**
     * @notice Emitted when deposit token created
     * @param instance Instance address
     * @param implementation Implementation address
     */
    event TokenCreated(address indexed instance, address indexed implementation);

    /**************************************************************************/
    /* API */
    /**************************************************************************/

    /**
     * @notice Get the deposit token address for tick
     *
     * @param tick Tick
     * @return Deposit token address
     */
    function depositToken(uint128 tick) public view virtual returns (address);

    /**
     * @notice Hook called by Pool on token transfers
     *
     * @param from From
     * @param to To
     * @param tick Tick
     * @param shares Shares
     */
    function onExternalTransfer(address from, address to, uint128 tick, uint256 shares) internal virtual;
}
