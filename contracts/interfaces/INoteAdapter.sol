// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "./ILoan.sol";

/**
 * @title Interface to a Note Adapter
 */
interface INoteAdapter is ILoan {
    function name() external view returns (string memory);

    function getLoanId(uint256 noteTokenId) external view returns (uint256);
}
