// SPDX-License-Identifier: BUSL-1.1
pragma solidity 0.8.20;

import "@openzeppelin/contracts/token/ERC1155/IERC1155.sol";
import "@openzeppelin/contracts/token/ERC1155/IERC1155Receiver.sol";
import "@openzeppelin/contracts/utils/math/SafeCast.sol";

import "./interfaces/IDeposit.sol";

library DepositToken {
    using SafeCast for uint256;

    /**************************************************************************/
    /* Events */
    /**************************************************************************/

    /**
     * @dev Emitted when `value` tokens of token type `id` are transferred from `from` to `to` by `operator`.
     */
    event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value);

    /**
     * @dev Equivalent to multiple {TransferSingle} events, where `operator`, `from` and `to` are the same for all
     * transfers.
     */
    event TransferBatch(
        address indexed operator,
        address indexed from,
        address indexed to,
        uint256[] ids,
        uint256[] values
    );

    /**
     * @dev Emitted when `account` grants or revokes permission to `operator` to transfer their tokens, according to
     * `approved`.
     */
    event ApprovalForAll(address indexed account, address indexed operator, bool approved);

    /**************************************************************************/
    /* Errors */
    /**************************************************************************/

    /**
     * @dev Standard ERC1155 Errors from OpenZeppelin implementation
     * Interface of the https://eips.ethereum.org/EIPS/eip-6093[ERC-6093] custom errors for ERC1155 tokens.
     */

    /**
     * @dev Indicates an error related to the current `balance` of a `sender`. Used in transfers.
     * @param sender Address whose tokens are being transferred.
     * @param balance Current balance for the interacting account.
     * @param needed Minimum amount required to perform a transfer.
     * @param tokenId Identifier number of a token.
     */
    error ERC1155InsufficientBalance(address sender, uint256 balance, uint256 needed, uint256 tokenId);

    /**
     * @dev Indicates a failure with the token `receiver`. Used in transfers.
     * @param receiver Address to which tokens are being transferred.
     */
    error ERC1155InvalidReceiver(address receiver);

    /**
     * @dev Indicates a failure with the `operator`’s approval. Used in transfers.
     * @param operator Address that may be allowed to operate on tokens without being their owner.
     * @param owner Address of the current owner of a token.
     */
    error ERC1155MissingApprovalForAll(address operator, address owner);

    /**
     * @dev Indicates a failure with the `operator` to be approved. Used in approvals.
     * @param operator Address that may be allowed to operate on tokens without being their owner.
     */
    error ERC1155InvalidOperator(address operator);

    /**
     * @dev Indicates an array length mismatch between ids and values in a safeBatchTransferFrom operation.
     * Used in batch transfers.
     * @param idsLength Length of the array of token identifiers
     * @param valuesLength Length of the array of token amounts
     */
    error ERC1155InvalidArrayLength(uint256 idsLength, uint256 valuesLength);

    /**************************************************************************/
    /* Token Internal Functions */
    /**************************************************************************/

    /**
     * @notice Check onERC1155Received before transferring
     *
     * @dev OpenZeppelin implementation
     *
     * @param operator Operator
     * @param from Transfer from address
     * @param to Transfer to address
     * @param tick Pool tick / IERC1155 id
     * @param amount Shares to transfer
     */
    function _doSafeTransferAcceptanceCheck(
        address operator,
        address from,
        address to,
        uint256 tick,
        uint256 amount
    ) private {
        if (to.code.length > 0) {
            try IERC1155Receiver(to).onERC1155Received(operator, from, tick, amount, "") returns (bytes4 response) {
                if (response != IERC1155Receiver.onERC1155Received.selector) {
                    // Tokens rejected
                    revert ERC1155InvalidReceiver(to);
                }
            } catch (bytes memory reason) {
                if (reason.length == 0) {
                    // non-ERC1155Receiver implementer
                    revert ERC1155InvalidReceiver(to);
                } else {
                    /// @solidity memory-safe-assembly
                    assembly {
                        revert(add(32, reason), mload(reason))
                    }
                }
            }
        }
    }

    /**
     * @notice Check onERC1155BatchReceived before transferring
     *
     * @dev OpenZeppelin implementation
     *
     * @param operator Operator
     * @param from Transfer from address
     * @param to Transfer to address
     * @param ticks Array of Pool ticks / IERC1155 ids
     * @param amounts Array of shares to transfer
     */
    function _doSafeBatchTransferAcceptanceCheck(
        address operator,
        address from,
        address to,
        uint256[] memory ticks,
        uint256[] memory amounts
    ) private {
        if (to.code.length > 0) {
            try IERC1155Receiver(to).onERC1155BatchReceived(operator, from, ticks, amounts, "") returns (
                bytes4 response
            ) {
                if (response != IERC1155Receiver.onERC1155BatchReceived.selector) {
                    // Tokens rejected
                    revert ERC1155InvalidReceiver(to);
                }
            } catch (bytes memory reason) {
                if (reason.length == 0) {
                    // non-ERC1155Receiver implementer
                    revert ERC1155InvalidReceiver(to);
                } else {
                    /// @solidity memory-safe-assembly
                    assembly {
                        revert(add(32, reason), mload(reason))
                    }
                }
            }
        }
    }

    /**************************************************************************/
    /* ERC1155 Implementation */
    /**************************************************************************/

    /**
     * @notice IERC1155 balanceOf implementation
     *
     * @param deposits Pool deposits mapping
     * @param account Account
     * @param tick Pool tick / ERC1155 id
     *
     * @return Number of shares owned
     */
    function balanceOf(
        mapping(address => mapping(uint128 => IDeposit.Deposit)) storage deposits,
        address account,
        uint256 tick
    ) internal view returns (uint256) {
        return deposits[account][tick.toUint128()].shares;
    }

    /**
     * @notice IERC1155 balanceOfBatch implementation
     *
     * @param deposits Pool deposits mapping
     * @param accounts Array of accounts
     * @param ticks Array of ticks / ERC1155 ids
     *
     * @return Array of number of shares owned
     */
    function balanceOfBatch(
        mapping(address => mapping(uint128 => IDeposit.Deposit)) storage deposits,
        address[] calldata accounts,
        uint256[] calldata ticks
    ) internal view returns (uint256[] memory) {
        if (accounts.length != ticks.length) {
            revert ERC1155InvalidArrayLength(ticks.length, accounts.length);
        }

        uint256[] memory batchBalances = new uint256[](accounts.length);

        for (uint256 i = 0; i < accounts.length; ++i) {
            batchBalances[i] = balanceOf(deposits, accounts[i], ticks[i]);
        }

        return batchBalances;
    }

    /**
     * @notice Validate IERC1155 setApprovalForAll
     *
     * @param operator Operator
     * @param approved Approved boolean
     */
    function afterApprovalForAll(address operator, bool approved) internal {
        if (operator == address(0)) {
            revert ERC1155InvalidOperator(address(0));
        }

        emit ApprovalForAll(msg.sender, operator, approved);
    }

    /**
     * @notice IERC1155 isApprovedForAll implementation
     *
     * @param operatorApprovals Operator approvals mapping
     * @param account Account
     * @param operator Operator
     */
    function isApprovedForAll(
        mapping(address => mapping(address => bool)) storage operatorApprovals,
        address account,
        address operator
    ) internal view returns (bool) {
        return operatorApprovals[account][operator];
    }

    /**************************************************************************/
    /* Hooks */
    /**************************************************************************/

    /**
     * @notice Hook called before updating balances in Pool
     *
     * @dev Validates sender has sufficient balance on transfers
     *
     * @param deposits Pool _deposits mapping
     * @param from From address (zero address on mints)
     * @param tick Pool tick
     * @param amount Amount
     */
    function beforeUpdate(
        mapping(address => mapping(uint128 => IDeposit.Deposit)) storage deposits,
        address from,
        uint256 tick,
        uint256 amount
    ) internal view {
        /* Check sender balance if transfer */
        if (from != address(0)) {
            uint128 tick_ = tick.toUint128();
            uint128 amount_ = amount.toUint128();

            uint128 fromBalance = deposits[from][tick_].shares;

            if (fromBalance < amount_) {
                revert ERC1155InsufficientBalance(from, fromBalance, amount_, tick_);
            }
        }
    }

    /**
     * @notice Hook called before updating balances in Pool
     *
     * @dev Validates sender has sufficient balance on batch transfers
     *
     * @param deposits Pool _deposits mapping
     * @param from From address (zero address on mints)
     * @param ticks Array of ticks
     * @param amounts Array of amounts
     */
    function beforeUpdateBatch(
        mapping(address => mapping(uint128 => IDeposit.Deposit)) storage deposits,
        address from,
        uint256[] memory ticks,
        uint256[] memory amounts
    ) internal view {
        if (from != address(0)) {
            for (uint256 i = 0; i < ticks.length; i++) {
                uint128 tick_ = ticks[i].toUint128();
                uint128 amount_ = amounts[i].toUint128();

                uint128 fromBalance = deposits[from][tick_].shares;

                if (fromBalance < amount_) {
                    revert ERC1155InsufficientBalance(from, fromBalance, amount_, tick_);
                }
            }
        }
    }

    /**
     * @notice Called prior to Pool safeTransferFrom() and safeBatchTransferFrom()
     *
     * @param operatorApprovals Operator approvals mapping from Pool
     * @param from From
     * @param to To
     */
    function beforeTransfer(
        mapping(address => mapping(address => bool)) storage operatorApprovals,
        address msgSender,
        address from,
        address to
    ) internal view {
        if (from != msgSender && !isApprovedForAll(operatorApprovals, from, msgSender)) {
            revert ERC1155MissingApprovalForAll(msgSender, from);
        }

        if (to == address(0)) {
            revert ERC1155InvalidReceiver(address(0));
        }
    }

    /**
     * @notice Called after updating balances
     *
     * @dev Validates recipient is valid ERC1155 Receiver and emits event
     *
     * @param msgSender msg.sender
     * @param from From
     * @param to To
     * @param tick Tick
     * @param amount Amount
     */
    function afterUpdate(address msgSender, address from, address to, uint256 tick, uint256 amount) internal {
        _doSafeTransferAcceptanceCheck(msgSender, from, to, tick, amount);

        emit TransferSingle(msgSender, from, to, tick, amount);
    }

    /**
     * @notice Called after updating batch balances
     *
     * @dev Validates recipient is valid ERC1155 Receiver and emits event
     *
     * @param msgSender msg.sender
     * @param from From
     * @param to To
     * @param ticks Ticks
     * @param amounts Amounts
     */
    function afterUpdateBatch(
        address msgSender,
        address from,
        address to,
        uint256[] memory ticks,
        uint256[] memory amounts
    ) internal {
        _doSafeBatchTransferAcceptanceCheck(msgSender, from, to, ticks, amounts);

        emit TransferBatch(msgSender, from, to, ticks, amounts);
    }
}
