// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.20;

import "@openzeppelin/contracts/utils/Create2.sol";
import "@openzeppelin/contracts/proxy/beacon/BeaconProxy.sol";

import "./DepositToken.sol";
import "./DepositERC20.sol";
import "./DepositERC20Proxy.sol";

/**
 * @title Deposit Token Factory (ERC20)
 * @author MetaStreet Labs
 */
contract DepositERC20Factory is DepositToken {
    /**************************************************************************/
    /* Structures */
    /**************************************************************************/

    /**
     * @custom:storage-location erc7201:depositErc20Factory.depositTokenStorage
     */
    struct DepositTokenStorage {
        /* Mapping of tick to token address */
        mapping(uint128 => address) tokens;
    }

    /**************************************************************************/
    /* State */
    /**************************************************************************/

    /**
     * @notice Current ERC20 token implementation
     */
    address internal immutable _implementation;

    /**
     * @notice Deposit token storage slot
     * @dev keccak256(abi.encode(uint256(keccak256("depositErc20Factory.depositTokenStorage")) - 1)) & ~bytes32(uint256(0xff));
     */
    bytes32 private constant DEPOSIT_TOKEN_STORAGE_LOCATION =
        0x7e9ad7c9814ad4f7bdba929e7e3a714dffcda760893cc5e488efa94b70014500;

    /**************************************************************************/
    /* Constructor */
    /**************************************************************************/

    /**
     * @notice DepositERC20Factory constructor
     *
     * @param implementation_ DepositERC20 implementation address
     */
    constructor(address implementation_) {
        _implementation = implementation_;
    }

    /**************************************************************************/
    /* Internal Helpers */
    /**************************************************************************/

    /**
     * @notice Get reference to ERC-7201 deposit token storage
     *
     * @return $ Reference to deposit token storage
     */
    function _getDepositTokenStorage() private pure returns (DepositTokenStorage storage $) {
        assembly {
            $.slot := DEPOSIT_TOKEN_STORAGE_LOCATION
        }
    }

    /**
     * @notice Create deterministic proxy for tick with Create2
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
            abi.encodePacked(type(DepositERC20Proxy).creationCode, initData)
        );

        /* Store token instance in mapping */
        _getDepositTokenStorage().tokens[tick] = tokenInstance;

        emit TokenCreated(tokenInstance, _implementation);
    }

    /**************************************************************************/
    /* Getters */
    /**************************************************************************/

    /**
     * @notice Get Deposit ERC20 implementation adress
     *
     * @return Deposit ERC20 implementation address
     */
    function getDepositERC20Implementation() external view returns (address) {
        return _implementation;
    }

    /**
     * @inheritdoc DepositToken
     */
    function depositToken(uint128 tick) public view override returns (address) {
        return _getDepositTokenStorage().tokens[tick];
    }

    /**************************************************************************/
    /* API */
    /**************************************************************************/

    /**
     * @notice Optionally tokenize a tick
     *
     * @param tick Tick
     */
    function tokenize(uint128 tick) external {
        /* No operation if token already exists */
        if (depositToken(tick) != address(0)) return;

        /* Create deterministic proxy if does not exist */
        _createDeterministicProxy(tick);
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
        /* No operation if token does not exist */
        if (depositToken(tick) == address(0)) return;

        /* Call external transfer hook */
        DepositERC20(depositToken(tick)).onExternalTransfer(from, to, shares);
    }
}
