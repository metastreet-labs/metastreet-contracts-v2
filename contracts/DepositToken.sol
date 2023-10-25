// SPDX-License-Identifier: MIT
pragma solidity 0.8.20;

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
     * @notice Get deterministic address for given tick
     *
     * @param tick Tick
     */
    function depositToken(uint128 tick) public view virtual returns (address);

    /**
     * @notice Hook called by Pool used to access token instance
     *
     * @param from From
     * @param to To
     * @param tick Tick
     * @param amount Amount
     */
    function onExternalTransfer(address from, address to, uint128 tick, uint256 amount) internal virtual;
}
