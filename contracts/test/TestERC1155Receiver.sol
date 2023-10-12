// SPDX-License-Identifier: MIT

pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC1155/IERC1155Receiver.sol";
import "@openzeppelin/contracts/utils/introspection/ERC165.sol";

contract TestERC1155Receiver is ERC165, IERC1155Receiver {
    bytes4 private _recRetval;
    bool private _recReverts;
    bytes4 private _batRetval;
    bool private _batReverts;

    bool private _wasOnERC1155ReceivedCalled;
    bool private _wasOnERC1155BatchReceivedCalled;

    event Received(address operator, address from, uint256 id, uint256 value, bytes data, uint256 gas);
    event BatchReceived(address operator, address from, uint256[] ids, uint256[] values, bytes data, uint256 gas);

    constructor(bytes4 recRetval, bool recReverts, bytes4 batRetval, bool batReverts) {
        _recRetval = recRetval;
        _recReverts = recReverts;
        _batRetval = batRetval;
        _batReverts = batReverts;
    }

    function onERC1155Received(
        address operator,
        address from,
        uint256 id,
        uint256 value,
        bytes calldata data
    ) external override returns (bytes4) {
        require(!_recReverts, "TestERC1155Receiver: reverting on receive");
        emit Received(operator, from, id, value, data, gasleft());
        _wasOnERC1155ReceivedCalled = true;
        return _recRetval;
    }

    function onERC1155BatchReceived(
        address operator,
        address from,
        uint256[] calldata ids,
        uint256[] calldata values,
        bytes calldata data
    ) external override returns (bytes4) {
        require(!_batReverts, "TestERC1155Receiver: reverting on batch receive");
        emit BatchReceived(operator, from, ids, values, data, gasleft());
        _wasOnERC1155BatchReceivedCalled = true;
        return _batRetval;
    }

    function wasOnERC1155ReceivedCalled() external view returns (bool) {
        return _wasOnERC1155ReceivedCalled;
    }

    function wasOnERC1155BatchReceivedCalled() external view returns (bool) {
        return _wasOnERC1155BatchReceivedCalled;
    }
}
