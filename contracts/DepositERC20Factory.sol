// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.20;

import "@openzeppelin/contracts/utils/Create2.sol";
import "@openzeppelin/contracts/proxy/beacon/BeaconProxy.sol";
import "@openzeppelin/contracts/proxy/beacon/IBeacon.sol";

import "./interfaces/IDepositERC20.sol";
import "./DepositToken.sol";

contract DepositERC20Factory is DepositToken, IBeacon {
    /**************************************************************************/
    /* State */
    /**************************************************************************/

    /**
     * @notice Current ERC20 token implementation
     */
    address internal immutable _implementation;

    /**
     * @notice Mapping of tick to token address
     */
    mapping(uint128 => address) internal _tokens;

    /**************************************************************************/
    /* Constructor */
    /**************************************************************************/

    /**
     * @notice DepositERC20Factory constructor
     *
     * @param implementation_ depositERC20 implementation address
     */
    constructor(address implementation_) {
        _implementation = implementation_;
    }

    /**************************************************************************/
    /* Internal Helpers */
    /**************************************************************************/

    /**
     * @notice Create proxy for tick using create2
     *
     * @param tick Tick
     */
    function _createDeterministicProxy(uint128 tick) private {
        /* Create init data */
        bytes memory initData = abi.encode(
            address(this),
            abi.encodeWithSignature("initialize(bytes)", abi.encode(tick))
        );

        /* Create token instance */
        address tokenInstance = Create2.deploy(
            0,
            bytes32(uint256(tick)),
            abi.encodePacked(type(BeaconProxy).creationCode, initData)
        );

        /* Store token instance in mapping */
        _tokens[tick] = tokenInstance;

        emit TokenCreated(tokenInstance, _implementation);
    }

    /**************************************************************************/
    /* Getters */
    /**************************************************************************/

    /**
     * @inheritdoc IBeacon
     */
    function implementation() external view override returns (address) {
        return _implementation;
    }

    /**
     * @inheritdoc DepositToken
     */
    function depositToken(uint128 tick) public view override returns (address) {
        return _tokens[tick];
    }

    /**************************************************************************/
    /* Hooks */
    /**************************************************************************/

    /**
     * @notice Hook called by Pool to create new token instance if it does not exist
     *         and call external transfer hook on token instance.
     *
     * @param from From
     * @param to To
     * @param tick Tick
     * @param shares Shares
     */
    function onExternalTransfer(address from, address to, uint128 tick, uint256 shares) internal override {
        /* Create token instance if it does not exist */
        if (_tokens[tick] == address(0)) {
            _createDeterministicProxy(tick);
        }

        /* Call external transfer hook */
        IDepositERC20(_tokens[tick]).onExternalTransfer(from, to, shares);
    }
}
