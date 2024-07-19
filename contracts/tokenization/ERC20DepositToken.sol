// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.25;

import "./DepositToken.sol";

import "./ERC20DepositTokenFactory.sol";
import "./ERC20DepositTokenImplementation.sol";

/**
 * @title ERC20 Deposit Token
 * @author MetaStreet Labs
 */
contract ERC20DepositToken is DepositToken {
    /**************************************************************************/
    /* Structures */
    /**************************************************************************/

    /**
     * @custom:storage-location erc7201:erc20DepositToken.depositTokenStorage
     */
    struct DepositTokenStorage {
        /* Mapping of tick to token address */
        mapping(uint128 => address) tokens;
    }

    /**************************************************************************/
    /* State */
    /**************************************************************************/

    /**
     * @notice Current ERC20 deposit token implementation
     */
    address internal immutable _implementation;

    /**
     * @notice Deposit token storage slot
     * @dev keccak256(abi.encode(uint256(keccak256("erc20DepositToken.depositTokenStorage")) - 1)) & ~bytes32(uint256(0xff));
     */
    bytes32 private constant DEPOSIT_TOKEN_STORAGE_LOCATION =
        0xc61d9ab4916a5eab6b572dc8707662b99e55e17ecdc61af8ff79465ad64ded00;

    /**************************************************************************/
    /* Constructor */
    /**************************************************************************/

    /**
     * @notice ERC20DepositToken constructor
     *
     * @param implementation_ ERC20 deposit token implementation address
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

    /**************************************************************************/
    /* API */
    /**************************************************************************/

    /**
     * @notice Get ERC20 Deposit Token implementation address
     *
     * @return ERC20 Deposit Token implementation address
     */
    function getERC20DepositTokenImplementation() external view returns (address) {
        return _implementation;
    }

    /**
     * @notice Tokenize a tick
     *
     * @param tick Tick
     */
    function _tokenize(uint128 tick) internal override returns (address) {
        /* Return token if it already exists */
        address tokenInstance = depositToken(tick);
        if (tokenInstance != address(0)) {
            emit TokenCreated(tokenInstance, _implementation, tick);

            return tokenInstance;
        }

        /* Create proxied token */
        tokenInstance = ERC20DepositTokenFactory.deploy(tick);

        /* Store token instance in mapping */
        _getDepositTokenStorage().tokens[tick] = tokenInstance;

        emit TokenCreated(tokenInstance, _implementation, tick);

        return tokenInstance;
    }

    /**
     * @inheritdoc DepositToken
     */
    function depositToken(uint128 tick) public view override returns (address) {
        return _getDepositTokenStorage().tokens[tick];
    }

    /**
     * @inheritdoc DepositToken
     */
    function _onExternalTransfer(address from, address to, uint128 tick, uint256 shares) internal override {
        /* No operation if token does not exist */
        if (depositToken(tick) == address(0)) return;

        /* Call external transfer hook */
        ERC20DepositTokenImplementation(depositToken(tick)).onExternalTransfer(from, to, shares);
    }
}
