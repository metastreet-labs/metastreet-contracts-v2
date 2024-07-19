// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.25;

import "@openzeppelin/contracts/utils/Create2.sol";

import "./ERC20DepositTokenProxy.sol";

/**
 * @title ERC20 Deposit Token Factory
 * @author MetaStreet Labs
 */
library ERC20DepositTokenFactory {
    /**
     * @notice Deploy a proxied ERC20 deposit token
     * @param tick Tick
     * @return Proxy address
     */
    function deploy(uint128 tick) external returns (address) {
        /* Create init data */
        bytes memory initData = abi.encode(
            address(this),
            abi.encodeWithSignature("initialize(bytes)", abi.encode(tick))
        );

        /* Create token instance */
        return
            Create2.deploy(
                0,
                bytes32(uint256(tick)),
                abi.encodePacked(type(ERC20DepositTokenProxy).creationCode, initData)
            );
    }
}
