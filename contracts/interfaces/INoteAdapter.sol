// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "./ILoanAdapter.sol";

/**
 * @title Interface to a Note Adapter
 */
interface INoteAdapter is ILoanAdapter {
    /**
     * Get note adapter name
     * @return Note adapter name
     */
    function name() external view returns (string memory);

    /**
     * Get loan ID from note token ID
     * @param noteTokenId Note token ID
     * @return Loan ID
     */
    function getLoanId(uint256 noteTokenId) external view returns (uint256);
}
